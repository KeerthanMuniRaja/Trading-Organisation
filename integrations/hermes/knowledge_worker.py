"""One bounded model-assisted transfer proposal; independent review stays in the backend."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sys

from adapter import Settings, HermesError, engine_label, profile_matches, verify_checkout
from development_worker import Client, locked, save
from knowledge import propose_knowledge, validate_plan
from inference_reporting import flush_report, mark_uncertain, timed_inference


def run_once(client, settings, body, request_key, directory, proposer=propose_knowledge, *, workflow='knowledge'):
    if workflow not in ('knowledge', 'sources'):
        raise HermesError('Unknown learning workflow')
    if workflow == 'sources':
        from source_learning import validate_lesson
        validator = validate_lesson
    else:
        validator = validate_plan
    route = '/v1/learning/' + workflow
    directory.mkdir(parents=True, exist_ok=True)
    identity = {'origin': client.base, 'credentialHash': hashlib.sha256(client.token.encode()).hexdigest(), 'key': request_key}
    if workflow != 'knowledge':
        identity['workflow'] = workflow
    stable = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    path = directory / (stable + '.json')
    with locked(directory / (stable + '.lock')):
        if path.exists():
            record = json.loads(path.read_text(encoding='utf-8'))
            if record['identity'] != identity or record['body'] != body:
                raise HermesError('Saved knowledge request differs')
        else:
            ticket = client.post(route + '/requests', body, request_key)
            record = {'identity': identity, 'body': body, 'ticket': ticket, 'inferenceStarted': False}
            save(path, record)
        ticket = record['ticket']
        profile = ticket['model']
        if not profile_matches(profile, settings):
            raise HermesError('Owner model profile differs from local settings')
        task, report_key = ('source-lesson' if workflow == 'sources' else 'knowledge'), 'inference-report-' + stable
        if 'proposal' not in record:
            if record['inferenceStarted']:
                mark_uncertain(record, path, save, task, engine_label(settings))
                flush_report(client, record, path, save, ticket['id'], report_key)
                raise HermesError('Uncertain model outcome; automatic regeneration forbidden')
            if datetime.fromisoformat(ticket['expiresAt'].replace('Z', '+00:00')) <= datetime.now(timezone.utc):
                raise HermesError('Knowledge request expired')
            client.post(route + '/preflight', {'requestId': ticket['id']})
            record['inferenceStarted'] = True
            save(path, record)
            try:
                record['proposal'] = timed_inference(record, path, save, task, lambda: proposer(settings, ticket['context']), engine_label(settings))
            except Exception:
                flush_report(client, record, path, save, ticket['id'], report_key)
                raise
            save(path, record)
        flush_report(client, record, path, save, ticket['id'], report_key)
        return client.post(route + '/proposals', {'requestId': ticket['id'], 'contextHash': ticket['contextHash'],
            'proposal': validator(record['proposal'], ticket['context'])}, 'knowledge-submit-' + stable)


def main():
    if sys.argv[1:2] == ['discover-learn']:
        from discovered_learning import run_discovered
        parser = argparse.ArgumentParser(description='Discover, freeze and propose one cross-bot learning plan')
        parser.add_argument('--bot-id', required=True)
        parser.add_argument('--query', required=True)
        parser.add_argument('--task', required=True)
        parser.add_argument('--request-key', required=True)
        args = parser.parse_args(sys.argv[2:])
        def settings_factory():
            settings = Settings.from_env()
            verify_checkout(settings)
            return settings
        client = Client(os.environ['API_URL'], os.environ['API_TOKEN'])
        print(json.dumps(run_discovered(client, {'botId': args.bot_id, 'query': args.query, 'task': args.task},
                                       args.request_key, Path(__file__).parent / '.state' / 'discovered-learning',
                                       settings_factory, proposal_runner=run_once)))
        return
    if sys.argv[1:2] == ['discover']:
        parser = argparse.ArgumentParser(description='Find reviewed cross-bot lessons without model inference')
        parser.add_argument('--bot-id', required=True)
        parser.add_argument('--query', required=True)
        parser.add_argument('--limit', type=int, default=5, choices=range(1, 21))
        args = parser.parse_args(sys.argv[2:])
        client = Client(os.environ['API_URL'], os.environ['API_TOKEN'])
        print(json.dumps(client.post('/v1/learning/knowledge/discover',
                                    {'botId': args.bot_id, 'query': args.query, 'limit': args.limit})))
        return
    if sys.argv[1:2] == ['workflow-run']:
        from learning_workflow import run_cycles
        parser = argparse.ArgumentParser(description='Advance one authorised learning workflow stage')
        parser.add_argument('--workflow-id', required=True)
        parser.add_argument('--role', required=True, choices=('researcher', 'evaluator'))
        parser.add_argument('--cycles', type=int, default=1)
        parser.add_argument('--interval-seconds', type=int, default=15)
        args = parser.parse_args(sys.argv[2:])
        client = Client(os.environ['API_URL'], os.environ['API_TOKEN'])
        print(json.dumps(run_cycles(client, args.workflow_id, Path(__file__).parent / '.state' / 'workflows', args.cycles, args.interval_seconds)))
        return
    if sys.argv[1:2] and sys.argv[1] in ('review','assessment-create','assessment-grade','source-review'):
        parser = argparse.ArgumentParser(description='Submit an independent evaluator decision from a JSON file')
        parser.add_argument('file')
        args = parser.parse_args(sys.argv[2:])
        with Path(args.file).open('rb') as handle:
            raw = handle.read(8193)
        if len(raw) > 8192:
            raise HermesError('Review exceeds limit')
        body = json.loads(raw)
        client = Client(os.environ['API_URL'], os.environ['API_TOKEN'])
        stable = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()
        routes={'review':'reviews','assessment-create':'assessments','assessment-grade':'assessments/grades'}
        action=sys.argv[1]
        route = '/v1/learning/sources/reviews' if action == 'source-review' else '/v1/learning/knowledge/'+routes[action]
        print(json.dumps(client.post(route, body, 'knowledge-'+action+'-' + stable)))
        return
    if sys.argv[1:2] == ['source-learn']:
        from source_learning import propose_lesson
        parser = argparse.ArgumentParser(description='Propose one cited source lesson, without self-review')
        parser.add_argument('--bot-id', required=True)
        parser.add_argument('--evidence-id', required=True)
        parser.add_argument('--request-key', required=True)
        args = parser.parse_args(sys.argv[2:])
        if not re.fullmatch(r'[A-Za-z0-9_-]{8,100}', args.request_key):
            parser.error('Use a stable request key of 8-100 characters')
        settings = Settings.from_env(); verify_checkout(settings)
        client = Client(os.environ['API_URL'], os.environ['API_TOKEN'])
        print(json.dumps(run_once(client, settings, {'botId': args.bot_id, 'evidenceId': args.evidence_id},
                                  args.request_key, Path(__file__).parent / '.state' / 'source-learning',
                                  proposer=propose_lesson, workflow='sources')))
        return
    if sys.argv[1:2]==['assess']:
        from knowledge_assessment_worker import run_once as assess
        parser=argparse.ArgumentParser(description='Answer a fresh issued assessment once; backend grades separately')
        parser.add_argument('--assessment-id',required=True)
        args=parser.parse_args(sys.argv[2:]);settings=Settings.from_env();verify_checkout(settings)
        client=Client(os.environ['API_URL'],os.environ['API_TOKEN'])
        print(json.dumps(assess(client,settings,args.assessment_id,Path(__file__).parent/'.state'/'knowledge-assessments')))
        return
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bot-id', required=True)
    parser.add_argument('--lesson-id', action='append', required=True)
    parser.add_argument('--task', required=True)
    parser.add_argument('--request-key', required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9_-]{8,100}', args.request_key):
        parser.error('Use a stable request key of 8-100 characters')
    settings = Settings.from_env(); verify_checkout(settings)
    client = Client(os.environ['API_URL'], os.environ['API_TOKEN'])
    body = {'botId': args.bot_id, 'lessonIds': args.lesson_id, 'task': args.task}
    print(json.dumps(run_once(client, settings, body, args.request_key, Path(__file__).parent / '.state' / 'knowledge')))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'event': 'knowledge.failed', 'message': 'Review the saved request; no automatic regeneration or authority change.'}), file=sys.stderr)
        raise SystemExit(1)
