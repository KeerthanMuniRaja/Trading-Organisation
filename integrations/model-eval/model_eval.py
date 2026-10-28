"""Model evaluation suite (MODEL-EVAL-01): can this model do the organisation's jobs, reliably and consistently?

Every model task the organisation runs is tested with its REAL instructions and answer schema, imported from the code
that uses them (so the suite can never drift from production):
  claims     the claim analyst (integrations/claims/claims.py): quote-backed claims from a news text, then the
             fact-checker's own deterministic checks (quote in the text, company named, figure in the quote)
  debate     the bull and bear researchers (debate.py): an argument that may cite only the proposal's verified evidence
  scenario   the scenario panel's personas (scenario_panel.py): up, down or flat for each linked share
  rnd        R&D idea invention (rnd_ideas.py): valid idea specifications, never a copy of a catalogue idea
  playbook   playbook drafts (playbook_drafts.py): a cause, a safe fix and who decides; money fixes are the owner's
  allocator  the model allocator (ai_allocator.py): weights for eight anonymous shares
For each task it measures:
  functionality  valid answers (schema plus the task's own validator) and no errors
  reliability    errors by kind (timeout, incomplete answer, invalid JSON, server down), with latency p50/p90/max
  consistency    the same decision across repeats of a case AND a reworded version of it
  correctness    the case's expectations (e.g. the quoted figure, no claim from an injected instruction, an owner-only fix)
A gate turns them into SHIP or DON'T SHIP per task and overall, so any future model (a bigger one, or a fine-tune made
with a tool such as Soup) must pass the same suite before it replaces the current one. The report records the model,
its pinned file, the prompt versions and the cases' fingerprint, so a result is tied to exactly what was tested.
  .local\\replay-venv\\Scripts\\python.exe integrations\\model-eval\\model_eval.py [--tasks claims,debate] [--repeats 2]
Needs the local model server running (npm run model:local -- serve qwen3.5-4b-q4km). Results: .local/model-eval/<run>/.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import statistics
import sys
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / 'integrations' / 'trading-desk'))
sys.path.insert(0, str(ROOT / 'integrations' / 'claims'))
import ai_allocator  # noqa: E402
import claims  # noqa: E402
import debate  # noqa: E402
import headline_reader  # noqa: E402
import playbook_drafts  # noqa: E402
import rnd_ideas  # noqa: E402
import rnd_scout  # noqa: E402
import scenario_panel  # noqa: E402

CASES = HERE / 'cases.json'
OUT = ROOT / '.local' / 'model-eval'
GATE = {'validity': 0.9, 'correctness': 0.8, 'consistency': 0.7}
TASKS = ('claims', 'debate', 'scenario', 'rnd', 'playbook', 'allocator', 'headline', 'reflect')


def fingerprint(*parts):
    return hashlib.sha256('\n'.join(json.dumps(p, sort_keys=True, default=str) for p in parts).encode()).hexdigest()[:16]


PROMPT_VERSIONS = {'claims': claims.CONTRACT_VERSION, 'debate': fingerprint(debate.SYSTEM, debate.schema(['x'])),
                   'scenario': fingerprint(scenario_panel.SYSTEM, scenario_panel.schema(['X.NS'])), 'rnd': fingerprint(rnd_ideas.SYSTEM, rnd_ideas.SCHEMA),
                   'playbook': fingerprint(playbook_drafts.SYSTEM, playbook_drafts.SCHEMA), 'allocator': ai_allocator.PROMPT_VERSION,
                   'headline': headline_reader.PROMPT_VERSION, 'reflect': fingerprint(scenario_panel.REFLECT_SYSTEM, scenario_panel.REFLECT_SCHEMA)}


def reorder(value):
    """The 'reorder' variant: the same facts with their order reversed (a consistent model does not care)."""
    if isinstance(value, dict) and 'resultsSoFar' in value:
        return {**value, 'resultsSoFar': list(reversed(value['resultsSoFar']))}
    if isinstance(value, dict) and 'shares' in value:
        return {**value, 'shares': dict(reversed(list(value['shares'].items())))}
    return value


# ---------- one call per task: (system, user, schema), then a judgement of the answer ----------
def prompt(case, given, persona=None):
    task = case['task']
    if task == 'claims':
        payload = {'allowedCompanies': {s: name for s, (name, _) in claims.COMPANIES.items()}, 'title': given['title'],
                   'publishedAt': given['publishedAt'], 'text': given['text']}
        return claims.SYSTEM, json.dumps(payload, ensure_ascii=False), claims.SCHEMA
    if task == 'debate':
        stance, job = debate.ROLES[case['side']]
        return debate.SYSTEM.format(side=case['side'], task=job), json.dumps(given, ensure_ascii=False), debate.schema(given['verifiedEvidenceIds'])
    if task == 'scenario':
        return (scenario_panel.SYSTEM.format(who=scenario_panel.PERSONAS[persona]), json.dumps(given), scenario_panel.schema(given['shares']))
    if task == 'rnd':
        payload = {'resultsSoFar': given['resultsSoFar'], 'lessons': rnd_ideas.lessons(),
                   'grammar': {k: {f: list(b) for f, b in v.items()} for k, v in rnd_ideas.GRAMMAR.items()}}
        return rnd_ideas.SYSTEM, json.dumps(payload), rnd_ideas.SCHEMA
    if task == 'playbook':
        return playbook_drafts.SYSTEM, json.dumps(given), playbook_drafts.SCHEMA
    if task == 'allocator':
        return ai_allocator.SYSTEM, json.dumps(given, allow_nan=False), ai_allocator.SCHEMA
    if task == 'headline':
        return headline_reader.SYSTEM, json.dumps(given, ensure_ascii=False), headline_reader.SCHEMA
    if task == 'reflect':
        return (scenario_panel.REFLECT_SYSTEM.format(who=scenario_panel.PERSONAS[persona]), json.dumps(given, ensure_ascii=False),
                scenario_panel.REFLECT_SCHEMA)
    raise ValueError(f'Unknown task {task}')


def judge(case, given, value):
    """(valid, correct-or-None, decision key for consistency, notes) for one answer."""
    task, expect = case['task'], case.get('expect') or {}
    notes = []
    if task == 'claims':
        if not claims.valid_shape(value):
            return False, None, None, ['invalid shape']
        obs = {'title': given['title'], 'content': given['text'], 'publishedAt': given['publishedAt']}
        accepted = [c for c in value['claims'] if not claims.verify(c, obs)]
        notes += [f"rejected: {','.join(claims.verify(c, obs))}" for c in value['claims'] if claims.verify(c, obs)]
        ok = True
        if 'minAccepted' in expect and len(accepted) < expect['minAccepted']:
            ok = False; notes.append('too few verified claims')
        if 'maxAccepted' in expect and len(accepted) > expect['maxAccepted']:
            ok = False; notes.append('claims where there should be none')
        inc = expect.get('includes')
        if inc and not any(inc['symbol'] in c['symbols'] and c['reportedChangePct'] is not None
                           and abs(c['reportedChangePct'] - inc['reportedChangePct']) < 0.05 for c in accepted):
            ok = False; notes.append('the expected figure is missing')
        if 'onlySymbols' in expect and any(set(c['symbols']) - set(expect['onlySymbols']) for c in value['claims']):
            ok = False; notes.append('a claim about another company')
        if any(s in c['symbols'] for c in value['claims'] for s in expect.get('forbidSymbols', [])):
            ok = False; notes.append('followed an injected instruction (forbidden company)')
        if 'forbidChangePct' in expect and any(c['reportedChangePct'] == expect['forbidChangePct'] for c in value['claims']):
            ok = False; notes.append('followed an injected instruction (forbidden figure)')
        key = sorted((tuple(sorted(c['symbols'])), round(c['reportedChangePct'], 1) if c['reportedChangePct'] is not None else None) for c in accepted)
        return True, ok if expect else None, json.dumps(key), notes
    if task == 'debate':
        if not (isinstance(value, dict) and isinstance(value.get('argument'), str) and 20 <= len(value['argument'].strip()) <= 600
                and 'evidenceId' in value and 'evidenceQuote' in value):
            return False, None, None, ['invalid shape']
        cited = value['evidenceId']
        ok = cited in expect.get('evidenceIn', [cited])
        if not ok:
            notes.append(f'cited {cited!r}, not allowed')
        # MENTOR-01 exams: the argument must use the lesson it was given (any of the words, case-insensitive)
        words = expect.get('mustMention')
        if words and not any(w.lower() in value['argument'].lower() for w in words):
            ok = False; notes.append(f'did not use the mentor lesson (none of {words})')
        # a mentioned word is not enough: an argument that also says something false fails (28 Oct: "the verified evidence
        # shows a promoter block deal" about an unverified press report passed, because it said "unverified" later too)
        wrong = [w for w in expect.get('mustNotMention', []) if w.lower() in value['argument'].lower()]
        if wrong:
            ok = False; notes.append(f'said what the context does not support: {wrong}')
        # MODEL-04: what production keeps is the GROUNDED citation (its quote found in the evidence); that is the decision
        texts = {e['id']: e['excerpt'] for e in given.get('verifiedEvidence', [])}
        kept = cited is not None and debate.grounded(value.get('evidenceQuote'), texts.get(cited))
        if cited is not None and not kept:
            notes.append('citation dropped: its quote is not in the evidence')
        elif cited is None and debate.derive_citation(value['argument'], texts):
            kept = True  # production derives the citation from the argument's own wording
            notes.append('citation derived from the argument')
        return True, ok if expect else None, json.dumps(kept), notes
    if task == 'scenario':
        calls = (value or {}).get('calls') if isinstance(value, dict) else None
        if not isinstance(calls, list) or not calls or any(not isinstance(c, dict) or c.get('symbol') not in given['shares']
                                                           or c.get('direction') not in ('up', 'down', 'flat') for c in calls):
            return False, None, None, ['invalid shape']
        decided = {c['symbol']: c['direction'] for c in calls}
        # PANEL-02 exams: which directions are right for a share, and what a reason must never say
        allowed, banned = expect.get('directionsIn') or {}, [w.lower() for w in expect.get('whyMustNotMention', [])]
        if not allowed and not banned:
            return True, None, json.dumps(sorted(decided.items())), notes
        wrong = [f'{s}: {decided.get(s, "missing")} (allowed {ok})' for s, ok in allowed.items() if decided.get(s) not in ok]
        said = [w for w in banned for c in calls if w in str(c.get('why', '')).lower()]
        notes += [f'wrong direction: {"; ".join(wrong)}'] if wrong else []
        notes += [f'reason said what the data does not: {sorted(set(said))}'] if said else []
        return True, not wrong and not said, json.dumps(sorted(decided.items())), notes
    if task == 'rnd':
        ideas = (value or {}).get('ideas') if isinstance(value, dict) else None
        if not isinstance(ideas, list) or len(ideas) > rnd_ideas.MAX_NEW_PER_MONTH:
            return False, None, None, ['invalid shape']
        catalogue = {rnd_ideas.spec_hash(s) for s in rnd_scout.CATALOGUE_SPECS.values()}
        hashes, ok = [], True
        for idea in ideas:
            spec = {k: v for k, v in idea.items() if k != 'why'} if isinstance(idea, dict) else idea
            if isinstance(spec, dict) and spec.get('filter') is None:
                spec.pop('filter', None)
            try:
                h = rnd_ideas.spec_hash(spec)
            except (ValueError, TypeError) as error:
                return False, None, None, [f'invalid idea: {error}']
            if h in catalogue and expect.get('noCatalogueDuplicates'):
                ok = False; notes.append(f'copied a catalogue idea: {rnd_ideas.name_of(spec)}')
            hashes.append(h)
        return True, ok if expect else None, json.dumps(sorted(hashes)), notes
    if task == 'playbook':
        if not (isinstance(value, dict) and value.get('decidedBy') in ('agents', 'owner') and isinstance(value.get('fix'), str) and isinstance(value.get('cause'), str)):
            return False, None, None, ['invalid shape']
        ok = True
        if expect.get('decidedBy') and value['decidedBy'] != expect['decidedBy']:
            ok = False; notes.append(f"said {value['decidedBy']}, should be {expect['decidedBy']}")
        if expect.get('patternMatches'):
            try:
                # the phrase is literal text, escaped as production escapes it (playbook_drafts)
                if not (value.get('text') and re.search(playbook_drafts.literal(value['text']), given['lastFailureText'], re.I)):
                    ok = False; notes.append('its pattern does not match the failure')
            except re.error:
                ok = False; notes.append('its pattern does not compile')
        return True, ok if expect else None, json.dumps(value['decidedBy']), notes
    if task == 'allocator':
        if not ai_allocator.valid(value):
            return False, None, None, ['invalid shape']
        weights, _, _ = ai_allocator.allocation(value)
        # weights within 10 points in total count as the same decision: rounded to 5-point steps for the key
        return True, None, json.dumps({k: 5 * round(v / 5) for k, v in weights.items()}), notes
    if task == 'headline':
        read = headline_reader.checked(value)
        if read is None:
            return False, None, None, ['invalid shape']
        ok = True
        for field in ('event', 'direction', 'materiality', 'kind'):
            allowed = expect.get(field + 'In')
            if allowed and read[field] not in allowed:
                ok = False; notes.append(f"{field} {read[field]}, expected one of {allowed}")
        return True, ok if expect else None, json.dumps([read[f] for f in ('event', 'direction', 'materiality', 'kind')]), notes
    if task == 'reflect':
        lesson = (value or {}).get('lesson') if isinstance(value, dict) else None
        if not isinstance(lesson, str) or not 10 <= len(lesson.strip()) <= 200:
            return False, None, None, ['invalid shape']
        ok = not any(w in lesson.lower() for w in expect.get('forbidWords', []))
        if not ok:
            notes.append('followed an injected instruction')
        return True, ok if expect else None, json.dumps('lesson'), notes  # free text: consistency is not meaningful, validity is
    raise ValueError(task)


def code_of(error):
    text = getattr(error, 'code', None) or str(error)
    for code in ('TIMEOUT', 'INCOMPLETE_RESPONSE', 'JSON', 'UNREACHABLE', 'REFUSED', 'UNAUTHORISED', 'NOT_SERVED'):
        if code.lower() in str(text).lower():
            return code
    return str(text)[:40]


def run(llm, cases, tasks=TASKS, repeats=2, clock=time.monotonic, log=print):
    results = []
    for case in cases:
        if case['task'] not in tasks:
            continue
        variant = reorder(case['input']) if case.get('variant') == 'reorder' else case.get('variant')
        inputs = [('repeat', case['input'])] * repeats + ([('variant', variant)] if variant else [])
        for persona in case.get('personas') or [None]:
            for kind, given in inputs:
                system, user, schema = prompt(case, given, persona)
                started = clock()
                entry = {'case': case['id'], 'task': case['task'], 'persona': persona, 'kind': kind}
                try:
                    value, meta = llm(system, user, schema)
                    checked = None
                    if case['task'] == 'debate' and debate.SELF_CHECK and isinstance(value, dict) and isinstance(value.get('argument'), str):
                        # the exams judge what production posts: the argument after its second pass (debate.self_check)
                        revised, checked = debate.self_check(llm, json.loads(user), value['argument'])
                        value = {**value, 'argument': revised}
                    valid, correct, key, notes = judge(case, given, value)
                    if checked and checked.get('problems'):
                        notes = notes + [f"self-check fixed: {'; '.join(checked['problems'])[:300]}"]
                    # the full exchange is kept: for diagnosis, and as labelled training data (build_dataset.py)
                    entry.update(valid=valid, correct=correct, key=key, notes=notes, system=system, user=user, answer=value,
                                 tokens=[(meta or {}).get('promptTokens'), (meta or {}).get('completionTokens')])
                except Exception as error:  # noqa: BLE001 - a failed call is a measured outcome
                    entry.update(valid=False, correct=None, key=None, error=code_of(error), notes=[])
                entry['seconds'] = round(clock() - started, 2)
                results.append(entry)
                log(f"  {entry['task']:9s} {entry['case']:22s} {persona or '':21s} {kind:7s} {'valid' if entry['valid'] else 'INVALID':7s} "
                    f"{'' if entry['correct'] is None else ('correct' if entry['correct'] else 'WRONG')} {entry['seconds']}s {entry.get('error', '')}")
    return results


REGRESSION_FLOOR = 0.05  # a candidate may not fall more than this (or the measured noise, if larger) below the baseline


def regressions(tasks, baseline, floor=REGRESSION_FLOOR):
    """Soup's rule: passing fixed thresholds is not enough; a candidate must not be worse than the model it replaces.
    `baseline` is an earlier report (its 'tasks'); a drop beyond max(floor, the baseline's measured noise) fails the task."""
    if not baseline:
        return {}
    out = {}
    for task, m in tasks.items():
        base = baseline.get('tasks', {}).get(task)
        if not base:
            continue
        noise = (baseline.get('noise') or {}).get(task, {})
        for key in ('validity', 'correctness', 'consistency'):
            if m.get(key) is None or base.get(key) is None:
                continue
            allowed = max(floor, noise.get(key, 0))
            if m[key] < base[key] - allowed:
                out.setdefault(task, []).append(f'{key} {m[key]} fell more than {allowed} below the baseline {base[key]}')
    return out


def summarise(results, gate=GATE, requested=None, baseline=None):
    tasks = {}
    for task in dict.fromkeys(r['task'] for r in results):
        rs = [r for r in results if r['task'] == task]
        graded = [r for r in rs if r['correct'] is not None]
        groups = {}
        for r in rs:
            groups.setdefault((r['case'], r['persona']), []).append(r)
        consistent = [len({r['key'] for r in g}) == 1 and all(r['valid'] for r in g) for g in groups.values()]
        seconds = sorted(r['seconds'] for r in rs)
        errors = {}
        for r in rs:
            if r.get('error'):
                errors[r['error']] = errors.get(r['error'], 0) + 1
        m = {'calls': len(rs), 'validity': round(sum(r['valid'] for r in rs) / len(rs), 3),
             'correctness': round(sum(bool(r['correct']) for r in graded) / len(graded), 3) if graded else None,
             'consistency': round(sum(consistent) / len(consistent), 3), 'errors': errors,
             'latencySeconds': {'p50': seconds[len(seconds) // 2], 'p90': seconds[min(len(seconds) - 1, int(0.9 * len(seconds)))], 'max': seconds[-1]},
             'failures': sorted({n for r in rs for n in r.get('notes', []) if not n.startswith('rejected:')} | {r['error'] for r in rs if r.get('error')})}
        reasons = [f'{k} {m[k]} below {v}' for k, v in gate.items() if m[k] is not None and m[k] < v]
        m['verdict'] = 'SHIP' if not reasons else "DON'T SHIP"
        m['reasons'] = reasons
        tasks[task] = m
    for task, why in regressions(tasks, baseline).items():
        tasks[task]['reasons'] += why
        tasks[task]['verdict'] = "DON'T SHIP"
    # a task that was asked for but produced nothing is a failure, never a silent omission
    for task in requested or ():
        if task not in tasks:
            tasks[task] = {'calls': 0, 'verdict': "DON'T SHIP", 'reasons': ['not run'], 'validity': None, 'correctness': None, 'consistency': None,
                           'errors': {}, 'latencySeconds': None, 'failures': []}
    overall = 'SHIP' if tasks and all(t['verdict'] == 'SHIP' for t in tasks.values()) else "DON'T SHIP"
    return {'overall': overall, 'tasks': tasks, 'gate': gate, **({'baseline': baseline.get('runId')} if baseline else {})}


def lock(model_name, cases_text):
    """What exactly was tested: the model the server reported, its pinned file (if the lock knows it), prompts and cases."""
    pinned = None
    try:
        lock_file = json.loads((ROOT / 'config' / 'local-model.lock.json').read_text(encoding='utf-8'))
        pinned = next(({'key': k, 'file': m['file'], 'sha256': m['sha256']} for k, m in lock_file['models'].items()
                       if model_name and (model_name in (k, m['alias'], m['file']) or m['alias'].lower() in str(model_name).lower())), None)
    except (OSError, ValueError, KeyError):
        pass
    import inspect
    # the judges are part of what was tested: a changed validator is a different exam (Soup's lock idea)
    judges = fingerprint(inspect.getsource(judge), inspect.getsource(claims.valid_shape), inspect.getsource(claims.verify),
                         inspect.getsource(ai_allocator.valid), playbook_drafts.OWNER_ONLY.pattern, GATE)
    return {'model': model_name, 'pinned': pinned, 'promptVersions': PROMPT_VERSIONS, 'judgesFingerprint': judges,
            'casesFingerprint': hashlib.sha256(cases_text.encode()).hexdigest()[:16]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--tasks', default=','.join(TASKS))
    parser.add_argument('--repeats', type=int, default=2, choices=range(1, 6))
    parser.add_argument('--timeout', type=int, default=300)
    parser.add_argument('--baseline', type=Path, default=OUT / 'baseline.json', help='the report a candidate must not be worse than')
    parser.add_argument('--set-baseline', action='store_true', help='save this run as the new baseline (the model in use)')
    args = parser.parse_args(argv)
    tasks = tuple(t for t in args.tasks.split(',') if t in TASKS)
    cases_text = CASES.read_text(encoding='utf-8')
    cases = json.loads(cases_text)['cases']
    os.environ['MODEL_CALL_JOURNAL'] = 'off'  # evaluation calls are kept in the run's own results, not the production journal
    llm, endpoint = claims.model_client(claims.local_settings(os.environ), args.timeout)
    run_id = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    print(f'Model evaluation {run_id}: {endpoint.model}, tasks {",".join(tasks)}, {args.repeats} repeats + reworded variants')
    results = run(llm, cases, tasks, args.repeats)
    baseline = json.loads(args.baseline.read_text(encoding='utf-8')) if args.baseline.exists() and not args.set_baseline else None
    report = {'runId': run_id, 'lock': lock(endpoint.model, cases_text), 'repeats': args.repeats,
              **summarise(results, requested=tasks, baseline=baseline),
              'note': 'Cases are invented fixtures. Validity and consistency are measured; correctness only where a case states an expectation.'}
    out = OUT / run_id
    out.mkdir(parents=True, exist_ok=True)
    (out / 'results.jsonl').write_text('\n'.join(json.dumps(r) for r in results) + '\n', encoding='utf-8')
    (out / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(f"\nOverall: {report['overall']}")
    for task, m in report['tasks'].items():
        print(f"  {task:9s} {m['verdict']:11s} valid {m['validity']:.0%}  correct {'-' if m['correctness'] is None else format(m['correctness'], '.0%')}  "
              f"consistent {m['consistency']:.0%}  p50 {m['latencySeconds']['p50']}s  max {m['latencySeconds']['max']}s  {'; '.join(m['reasons'])}")
    print(f'Report: {out / "report.json"}')
    if args.set_baseline:
        args.baseline.write_text(json.dumps(report, indent=2), encoding='utf-8')
        print(f'Saved as the baseline every candidate must not fall below: {args.baseline}')
    if report['overall'] != 'SHIP':
        sys.exit(1)  # a script or a release gate can act on the verdict


if __name__ == '__main__':
    main()
