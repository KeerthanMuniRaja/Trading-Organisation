from argparse import Namespace
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
from unittest.mock import patch
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import autolearn

NOW = datetime(2026, 10, 4, 12, 0, tzinfo=timezone.utc)
TEXTS = {
    'e1': ('src-a', '2026-10-03T10:00:00Z', 'Reliance Industries reported a 12% rise in quarterly net profit, the company said on Friday.'),
    'e2': ('src-b', '2026-10-03T12:00:00Z', "RIL's profit for the September quarter climbed 12% on strong retail sales, analysts noted."),
    'e3': ('src-a', '2026-10-03T09:00:00Z', 'Markets were closed for a holiday on Thursday and trading resumes next week.'),
    'e4': ('src-c', '2026-10-04T10:00:00Z', "Reliance Industries' quarterly net profit actually fell 3%, according to a revised filing."),
    'e5': ('src-c', '2026-10-03T13:00:00Z', 'Reliance Industries won a large solar equipment order from a state utility this week.'),
}
# (quote, direction, reported change); every claim is about net profit for Q2 FY27 except the order (no figure, no fact key)
QUOTES = {'e1': ('Reliance Industries reported a 12% rise in quarterly net profit', 'positive', 12),
          'e2': ('profit for the September quarter climbed 12% on strong retail sales', 'positive', 12),
          'e4': ('quarterly net profit actually fell 3%, according to a revised filing', 'negative', -3),
          'e5': ('won a large solar equipment order from a state utility', 'positive', None)}
CONFIG = {'recipientBotIds': ['news-desk', 'research-lead'], 'primarySourceIds': [], 'holdDays': 7, 'maxModelCallsPerCycle': 20}


def observation(evidence):
    source, published, text = TEXTS[evidence]
    return {'evidence_id': evidence, 'source_id': source, 'source_name': source.upper(), 'url': f'https://{source}.example/{evidence}',
            'title': 'Company news', 'content': text, 'published_at': published, 'status': 'unverified'}


def stub_model(system, user, schema):
    """Drafts the planted claim for each article; the holiday notice has none."""
    text = json.loads(user)['text']
    for evidence, (_, _, body) in TEXTS.items():
        if body == text and evidence in QUOTES:
            quote, direction, change = QUOTES[evidence]
            fact = {'metric': None, 'period': None} if change is None else {'metric': 'Net profit', 'period': 'Q2 FY27'}
            return {'claims': [{'statement': 'Reliance quarterly profit news.', 'quote': quote, 'symbols': ['RELIANCE.NS'],
                                'eventType': 'earnings', 'direction': direction, 'eventDate': None, 'certainty': 'reported-fact',
                                **fact, 'reportedChangePct': change}]}, {}
    return {'claims': []}, {}


class FakeBackend:
    """Enforces the real routes' rules: roles, author != reviewer, verified evidence for lessons, idempotent retries."""

    def __init__(self, ids):
        self.evidence = {i: {**observation(i), 'author': 'collector'} for i in ids}
        self.lessons, self.claims, self.done, self.mutations = {}, {}, {}, []

    def add(self, evidence):
        self.evidence[evidence] = {**observation(evidence), 'author': 'collector'}

    def api(self, role):
        def call(method, route, body=None):
            if method == 'POST' and route not in ('/v1/sources/observations/review-queue', '/v1/evidence/status'):
                key = (role, route, json.dumps(body, sort_keys=True))
                if key not in self.done:
                    self.mutations.append((role, route, body))
                    self.done[key] = self.handle(role, route, body)
                return self.done[key]
            return self.handle(role, route, body)
        return call

    def handle(self, role, route, body):
        if route == '/v1/evidence/status':
            return {'evidence': [{**e, 'id': i, 'kind': e.get('kind', 'news'),
                'source_approved': e.get('source_approved', True),
                'usable': e['status'] == 'verified' and e.get('source_approved', True)}
                for i, e in self.evidence.items() if i in body['evidenceIds']]}
        if route == '/v1/sources/observations/review-queue':
            assert role == 'evaluator'
            rows = [{**{k: v for k, v in e.items() if k != 'author'}, 'blockers': []} for e in self.evidence.values() if e['status'] == 'unverified']
            return {'observations': rows, 'nextCursor': None}
        if route == '/v1/evidence/reviews':
            e = self.evidence[body['evidenceId']]
            assert role == 'evaluator' and e['author'] != role and e['status'] == 'unverified'
            expected = body['expected']
            if (e['content'] != expected['content'] or e['source_id'] != expected['sourceId']
                    or e['title'] != expected['observation']['title'] or e['url'] != expected['observation']['url']):
                raise RuntimeError('Stored evidence does not match')
            e['status'] = body['status']
            return body
        if route == '/v1/lessons':
            assert role == 'researcher' and self.evidence[body['evidenceId']]['status'] == 'verified'
            lesson_id = f'lesson-{len(self.lessons) + 1}'
            self.lessons[lesson_id] = {**body, 'id': lesson_id, 'status': 'unverified', 'author': role}
            return {'id': lesson_id, 'status': 'unverified'}
        if route == '/v1/lessons/reviews':
            lesson = self.lessons[body['lessonId']]
            assert role == 'evaluator' and lesson['author'] != role and self.evidence[lesson['evidenceId']]['status'] == 'verified'
            expected = body.get('expected')
            if expected and any(lesson[k] != expected[k] for k in ('content', 'evidenceId', 'botId')):
                raise RuntimeError('Stored lesson does not match')
            lesson['status'] = 'verified'
            return {'id': lesson['id'], 'status': 'verified'}
        if route == '/v1/evidence/claims':
            # the real route's checks: researcher, live evidence, the quote in the stored article body
            e = self.evidence[body['evidenceId']]
            assert role == 'researcher' and e['status'] in ('unverified', 'verified')
            if body['quote'] not in ' '.join(e['content'].split()):
                raise RuntimeError('/v1/evidence/claims refused (HTTP 400)')
            assert all('.' not in s for s in body['symbols']) and (('metric' in body) == ('period' in body))
            claim_id = f'claim-{len(self.claims) + 1}'
            self.claims[claim_id] = {**body, 'author': role, 'review': None}
            return {'id': claim_id, 'status': 'pending', 'duplicate': False}
        if route == '/v1/evidence/claims/reviews':
            c = self.claims[body['claimId']]
            assert role == 'evaluator' and c['author'] != role and c['review'] is None
            assert body['decision'] != 'accepted' or self.evidence[c['evidenceId']]['status'] == 'verified'
            c['review'] = body['decision']
            return {'id': body['claimId'], 'decision': body['decision']}
        if route == '/v1/evidence/revocations':
            assert role == 'evaluator' and body['kind'] == 'evidence'
            self.evidence[body['targetId']]['status'] = 'revoked'
            return {'id': body['targetId']}
        if route == '/v1/knowledge':
            return {'lessons': [{'id': lesson['id'], 'bot_id': lesson['botId'], 'content': lesson['content'], 'evidence_id': lesson['evidenceId']}
                                for lesson in self.lessons.values()
                                if lesson['status'] == 'verified' and self.evidence[lesson['evidenceId']]['status'] == 'verified']}
        raise AssertionError(route)

    def knowledge(self):
        return self.handle('evaluator', '/v1/knowledge', None)['lessons']


def desk_validator():
    """The trading desk's own headline validator."""
    import importlib.util
    path = autolearn.claims.ROOT / 'integrations' / 'trading-desk' / 'desk.py'
    sys.path.insert(0, str(path.parent))
    spec = importlib.util.spec_from_file_location('desk_for_autolearn', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.validate_headlines


def cycle(backend, state, config=CONFIG, now=NOW, until='factcheck-lessons'):
    out = {'queue': autolearn.factcheck_queue(backend.api('evaluator'), state),
           'extract': autolearn.analyst_extract(stub_model, 'stub', state, config),
           'evidence': autolearn.factcheck_evidence(backend.api('evaluator'), state, config, now)}
    out['lessons'] = autolearn.analyst_lessons(backend.api('researcher'), state, config)
    if until == 'factcheck-lessons':
        out['review'] = autolearn.factcheck_lessons(backend.api('evaluator'), state, config, now)
    return out


class AutoLearnTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state = Path(self.tmp.name) / 'state'

    def tearDown(self):
        self.tmp.cleanup()

    def decisions(self):
        return autolearn.read(self.state, 'decisions.json', {})

    def test_corroborated_news_becomes_verified_knowledge_without_a_human(self):
        backend = FakeBackend(['e1', 'e2', 'e3'])
        first = cycle(backend, self.state)
        self.assertEqual(first['queue']['pending'], 3)
        self.assertEqual(first['evidence'], {'corroborated': 2, 'no-checkable-claims': 1})
        self.assertEqual([backend.evidence[e]['status'] for e in ('e1', 'e2', 'e3')], ['verified', 'verified', 'rejected'])
        self.assertEqual((first['lessons']['proposed'], first['review']['verified'], first['review']['revoked']), (4, 4, 0))
        # the backend's claim registry holds both verified claims, with their fact keys, accepted by the independent fact-checker
        self.assertEqual((first['lessons']['claimsRecorded'], first['review']['claimsAccepted']), (2, 2))
        self.assertEqual(sorted((c['symbols'], c['metric'], c['period'], c['reportedChangePct'], c['review']) for c in backend.claims.values()),
                         [(['RELIANCE'], 'net profit', 'Q2FY27', 12, 'accepted')] * 2)
        knowledge = backend.knowledge()
        self.assertEqual({k['bot_id'] for k in knowledge}, {'news-desk', 'research-lead'})
        headlines = autolearn.read(self.state, 'verified-headlines.json', None)
        self.assertEqual((first['review']['headlines'], len(headlines)), (2, 2))
        self.assertEqual(autolearn.headline_receipt.load(self.state / 'verified-headlines.json'), headlines)
        self.assertEqual(desk_validator()(headlines), headlines)  # ready for the trading desk's news analyst
        self.assertTrue(all('corroborated by independent reports' in k['content'] and 'not a trading signal' in k['content']
                            and 'Fact: net profit, Q2FY27, reported change +12%.' in k['content'] for k in knowledge))
        writes = len(backend.mutations)
        second = cycle(backend, self.state)  # nothing new: nothing is repeated
        self.assertEqual((second['queue']['pending'], second['extract']['callsThisRun'], second['lessons']['proposed']), (0, 0, 0))
        self.assertEqual(len(backend.mutations), writes)

    def test_single_source_waits_then_is_rejected_unless_it_is_a_primary_source(self):
        backend = FakeBackend(['e1'])
        cycle(backend, self.state)
        self.assertEqual(self.decisions()['e1']['reason'], 'awaiting-corroboration')
        self.assertEqual(backend.evidence['e1']['status'], 'unverified')
        cycle(backend, self.state, now=NOW + timedelta(days=8))
        self.assertEqual((self.decisions()['e1']['reason'], backend.evidence['e1']['status']), ('uncorroborated-after-7-days', 'rejected'))
        primary = FakeBackend(['e1'])
        state = Path(self.tmp.name) / 'primary'
        out = cycle(primary, state, config={**CONFIG, 'primarySourceIds': ['src-a']})
        self.assertEqual(out['evidence'], {'primary-source': 1})
        self.assertTrue(all('stated by a primary source' in k['content'] for k in primary.knowledge()))

    def test_later_contradiction_revokes_what_was_verified(self):
        backend = FakeBackend(['e1', 'e2'])
        cycle(backend, self.state)
        self.assertEqual(len(backend.knowledge()), 4)
        backend.add('e4')
        out = cycle(backend, self.state)
        self.assertEqual(out['evidence'], {'contradicted': 1})
        self.assertEqual(out['review']['revoked'], 2)
        self.assertEqual([backend.evidence[e]['status'] for e in ('e1', 'e2', 'e4')], ['revoked', 'revoked', 'unverified'])
        self.assertEqual(backend.knowledge(), [])  # bots no longer see the contradicted lessons
        self.assertEqual(autolearn.read(self.state, 'verified-headlines.json', None), [])  # nor does the desk's news analyst

    def test_fact_checker_rechecks_the_analysts_claims_itself(self):
        backend = FakeBackend(['e1', 'e2'])
        autolearn.factcheck_queue(backend.api('evaluator'), self.state)
        autolearn.analyst_extract(stub_model, 'stub', self.state, CONFIG)
        extracted = autolearn.read(self.state, 'extracted.json', {})
        extracted['results']['e2']['accepted'][0]['quote'] = 'profit for the quarter tripled to an all-time record high'
        autolearn.write(self.state, 'extracted.json', extracted)  # a drafted claim the article does not support
        out = autolearn.factcheck_evidence(backend.api('evaluator'), self.state, CONFIG, NOW)
        self.assertEqual(out, {'awaiting-corroboration': 1, 'no-claim-survived-recheck': 1})
        self.assertEqual(backend.evidence['e1']['status'], 'unverified')

    def test_backend_mismatch_stops_approval_before_publication(self):
        backend = FakeBackend(['e1', 'e2'])
        autolearn.factcheck_queue(backend.api('evaluator'), self.state)
        autolearn.analyst_extract(stub_model, 'stub', self.state, CONFIG)
        backend.evidence['e1']['content'] = 'Different stored report'
        with self.assertRaisesRegex(RuntimeError, 'Stored evidence'):
            autolearn.factcheck_evidence(backend.api('evaluator'), self.state, CONFIG, NOW)
        self.assertEqual(backend.evidence['e1']['status'], 'unverified')

    def test_headlines_reconcile_external_revocation_and_source_withdrawal(self):
        backend = FakeBackend(['e1', 'e2'])
        cycle(backend, self.state)
        backend.evidence['e1']['status'] = 'revoked'
        self.assertEqual(autolearn.export_headlines(backend.api('evaluator'), self.state, CONFIG), [])
        backend.evidence['e2']['source_approved'] = False
        self.assertEqual(autolearn.export_headlines(backend.api('evaluator'), self.state, CONFIG), [])
        self.assertEqual(autolearn.read(self.state, 'verified-headlines.json', None), [])

    def test_headline_status_failure_clears_old_export_and_missing_rows_are_excluded(self):
        backend = FakeBackend(['e1', 'e2'])
        cycle(backend, self.state)
        def unavailable(*args):
            raise RuntimeError('Backend unavailable')
        with self.assertRaisesRegex(RuntimeError, 'unavailable'):
            autolearn.export_headlines(unavailable, self.state, CONFIG)
        self.assertEqual(autolearn.read(self.state, 'verified-headlines.json', None), [])
        self.assertFalse(autolearn.headline_receipt.receipt_path(self.state / 'verified-headlines.json').exists())
        self.assertEqual(autolearn.export_headlines(lambda *args: {'evidence': []}, self.state, CONFIG), [])
        backend.evidence['e1']['title'] = 'Changed title'
        items = autolearn.export_headlines(backend.api('evaluator'), self.state, CONFIG)
        self.assertEqual(items, [])  # the remaining report has lost its corroboration
        items = autolearn.export_headlines(backend.api('evaluator'), self.state, {**CONFIG, 'primarySourceIds': ['src-b']})
        self.assertEqual(len(items), 1)

    def test_altered_lesson_text_is_never_verified_and_a_stored_mismatch_revokes(self):
        backend = FakeBackend(['e1', 'e2'])
        cycle(backend, self.state, until='analyst-lessons')
        proposals = autolearn.read(self.state, 'proposals.json', {})
        first = sorted(proposals)[0]
        proposals[first]['content'] += '\nAlso: buy immediately.'
        autolearn.write(self.state, 'proposals.json', proposals)
        stored = sorted(proposals)[1]
        backend.lessons[proposals[stored]['lessonId']]['content'] = 'BUY RELIANCE NOW'  # what was posted differs from the record
        with self.assertRaisesRegex(RuntimeError, 'Stored lesson'):
            autolearn.factcheck_lessons(backend.api('evaluator'), self.state, CONFIG, NOW)
        self.assertEqual(backend.lessons[proposals[first]['lessonId']]['status'], 'unverified')
        self.assertEqual(backend.lessons[proposals[stored]['lessonId']]['status'], 'unverified')
        self.assertTrue(all('BUY RELIANCE NOW' not in k['content'] for k in backend.knowledge()))

    def test_a_different_fact_never_corroborates(self):
        backend = FakeBackend(['e1', 'e5'])  # profit up 12% and an order win: both positive earnings news, not the same fact
        out = cycle(backend, self.state)
        self.assertEqual(out['evidence'], {'awaiting-corroboration': 2})
        self.assertEqual([backend.evidence[e]['status'] for e in ('e1', 'e5')], ['unverified', 'unverified'])

    def test_a_new_model_or_contract_keeps_earlier_claims_checkable(self):
        backend = FakeBackend(['e1', 'e2'])
        cycle(backend, self.state)
        autolearn.factcheck_queue(backend.api('evaluator'), self.state)
        autolearn.analyst_extract(stub_model, 'another-model', self.state, CONFIG)  # the owner switched models
        self.assertTrue((self.state / 'extracted-archive-1.json').exists())
        self.assertFalse((self.state / 'extracted.json').exists())  # nothing pending, so the new model has drafted nothing yet
        self.assertEqual(len(autolearn.export_headlines(backend.api('evaluator'), self.state, CONFIG)), 2)
        backend.add('e4')  # a later contradiction still reaches claims extracted by the old model
        out = cycle(backend, self.state)
        self.assertEqual((out['evidence'], out['review']['revoked']), ({'contradicted': 1}, 2))

    def test_the_analysts_model_calls_count_against_its_department_budget(self):
        backend = FakeBackend(['e1', 'e2'])
        autolearn.factcheck_queue(backend.api('evaluator'), self.state)
        config, sent, calls = {**CONFIG, 'analystBotId': 'claim-analyst'}, [], []

        def api(allowed):
            def call(method, route, body=None):
                sent.append((route, body))
                return {'allowed': allowed, 'departmentId': 'research', 'usedTodayTokens': '9000', 'budgetTokensPerDay': 8000} \
                    if route == '/v1/compute/allowance' else {'id': 'u1'}
            return call

        def model(system, user, schema):
            calls.append(1)
            value, _ = stub_model(system, user, schema)
            return value, {'promptTokens': 100, 'completionTokens': 20}
        spent = autolearn.analyst_extract(model, 'stub', self.state, config, api=api(False), now=NOW)
        self.assertTrue(spent['skipped'].startswith('compute budget: department research used 9000 of its 8000'))
        self.assertEqual(calls, [])  # no model call once the budget is used up
        out = autolearn.analyst_extract(model, 'stub', self.state, config, api=api(True), now=NOW)
        self.assertEqual((out['callsThisRun'], out['tokensThisRun'], out['computeReported']), (2, [200, 40], True))
        route, report = sent[-1]
        self.assertEqual((route, report['botId'], report['calls'], report['promptTokens'], report['completionTokens'], report['periodTo']),
                         ('/v1/compute/usage/reports', 'claim-analyst', 2, 200, 40, '2026-10-04'))
        self.assertNotIn('computeReported', autolearn.analyst_extract(model, 'stub', self.state, CONFIG))  # not configured: unchanged

    def test_contradiction_blocks_mixed_evidence_even_with_primary_or_corroborated_support(self):
        obs = {'publishedAt': '2026-10-03T10:00:00+00:00'}
        for support in ('corroborated', 'primary-source'):
            with patch.object(autolearn, 'claim_basis', side_effect=[support, 'contradicted']):
                self.assertEqual(autolearn.evidence_decision(obs, {'outcome': 'valid', 'accepted': [1, 2]},
                    [{}, {}], [], CONFIG, NOW), ('hold', 'contradicted'))


class OrchestrationTests(unittest.TestCase):
    PARENT = {'PATH': 'C:\\Windows', 'API_URL': 'http://127.0.0.1:3000', 'HERMES_MODEL': 'm', 'HERMES_MODEL_BASE_URL': 'http://127.0.0.1:8080/v1',
              'HERMES_MODEL_API_KEY': 'model-key', 'PRINCIPALS_JSON': json.dumps([
                  {'role': 'researcher', 'token': 'r-token'}, {'role': 'evaluator', 'token': 'e-token'}, {'role': 'owner', 'token': 'o-token'}])}

    def test_the_env_file_is_read_as_node_reads_it_quotes_included(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / '.env'
            path.write_text("# a comment\nPRINCIPALS_JSON='[{\"role\": \"evaluator\"}]'\nAPI_URL=\"http://127.0.0.1:3000\"\nPLAIN=a=b\nONE='\n",
                            encoding='utf-8')
            values = autolearn.env_file(path)
        self.assertEqual(json.loads(values['PRINCIPALS_JSON']), [{'role': 'evaluator'}])   # single quotes no longer break JSON
        self.assertEqual((values['API_URL'], values['PLAIN'], values['ONE']), ('http://127.0.0.1:3000', 'a=b', "'"))

    def test_each_step_gets_only_its_own_credential_and_only_extraction_gets_the_model(self):
        checker = autolearn.child_env('factcheck-lessons', {**self.PARENT,
            'OPENAI_API_KEY': 'unrelated', 'AWS_SECRET_ACCESS_KEY': 'unrelated',
            'PYTHONPATH': 'injected', 'NODE_OPTIONS': 'injected', 'OWNER_TOKEN': 'unrelated'}, {})
        for key in ('OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'PYTHONPATH', 'NODE_OPTIONS', 'OWNER_TOKEN'):
            self.assertNotIn(key, checker)
        self.assertEqual(json.loads(checker['PRINCIPALS_JSON']), [{'role': 'evaluator', 'token': 'e-token'}])
        self.assertFalse(any(k.startswith('HERMES_') for k in checker))
        self.assertEqual(checker['PATH'], 'C:\\Windows')
        analyst = autolearn.child_env('analyst-extract', self.PARENT, {})
        self.assertEqual(json.loads(analyst['PRINCIPALS_JSON']), [{'role': 'researcher', 'token': 'r-token'}])
        self.assertEqual(analyst['HERMES_MODEL_API_KEY'], 'model-key')
        self.assertNotIn('o-token', json.dumps(checker) + json.dumps(analyst))
        with self.assertRaisesRegex(ValueError, 'evaluator'):
            autolearn.child_env('factcheck-queue', {**self.PARENT, 'PRINCIPALS_JSON': '[]'}, {})
        with self.assertRaisesRegex(ValueError, 'exactly one evaluator'):
            autolearn.child_backend(analyst, 'evaluator')

    def test_sessions_are_finite_logged_and_stop_on_a_failed_step(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            config = tmp / 'config.json'
            config.write_text(json.dumps(CONFIG), encoding='utf-8')
            args = Namespace(config=config, state=tmp, cycles=3, interval_minutes=5, timeout_seconds=60, allow_remote_cost=False)
            seen, sleeps = [], []

            def runner(step, args, env):
                seen.append((step, json.loads(env['PRINCIPALS_JSON'])[0]['role']))
                return {'ok': True}
            log = autolearn.run(args, self.PARENT, runner, sleeps.append, private={})
            self.assertEqual(len(log), 3)
            self.assertEqual(seen[:5], [(s, r) for s, r in autolearn.STEPS.items()])
            self.assertEqual(sleeps, [300, 300])

            def failing(step, args, env):
                if step == 'analyst-extract':
                    raise RuntimeError('analyst-extract stopped: model unavailable')
                return {}
            log = autolearn.run(args, self.PARENT, failing, sleeps.append, private={})
            self.assertEqual(len(log), 1)
            self.assertIn('model unavailable', log[0]['stopped'])
            self.assertEqual(len((tmp / 'cycles.jsonl').read_text(encoding='utf-8').splitlines()), 4)

    def test_owner_configuration_is_validated(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'c.json'
            for bad in ({}, {'recipientBotIds': []}, {'recipientBotIds': ['ok'], 'holdDays': 99},
                        {'recipientBotIds': ['ok'], 'autoTrade': True}, {'recipientBotIds': ['../x']}):
                path.write_text(json.dumps(bad), encoding='utf-8')
                with self.assertRaises(ValueError):
                    autolearn.load_config(path)
            path.write_text(json.dumps({'recipientBotIds': ['news-desk']}), encoding='utf-8')
            self.assertEqual(autolearn.load_config(path)['holdDays'], 7)
            # the retired opt-in still loads (an existing configuration keeps working) and changes nothing
            path.write_text(json.dumps({'recipientBotIds': ['news-desk'], 'looseCorroborationVerifies': True}), encoding='utf-8')
            self.assertNotIn('looseCorroborationVerifies', autolearn.load_config(path))


if __name__ == '__main__':
    unittest.main()
