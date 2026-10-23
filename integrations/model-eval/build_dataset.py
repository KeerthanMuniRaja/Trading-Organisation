"""Training data from the organisation's own work (MODEL-DATA-01), ready for a fine-tune with a tool such as Soup.

Sources, both local:
  - the production journal of model calls (.local/model-calls/*.jsonl, written by the shared model client);
  - the model evaluation runs (.local/model-eval/*/results.jsonl).
Every answer is labelled by the organisation's OWN checks, never by the model itself:
  claims     the fact-checker's deterministic checks: the quote is in the text, the company is named, the figure is in the
             quote, the date is plausible
  debate     the citation is one of the proposal's verified evidence ids (or none)
  rnd        every idea is a valid specification and no copy of a catalogue idea
  playbook   a fix about money, limits, sources, credentials or releases is the owner's; the pattern compiles and matches
  scenario, allocator   opinions about the future: kept out until their calls are scored against what happened
Exports, per task, in .local/training-data/:
  sft.jsonl         answers that passed every check, as chat messages (system, user, assistant)
  preference.jsonl  an answer that failed a check (rejected) paired with the same answer corrected by the check (chosen),
                    in the conversational prompt/chosen/rejected form preference trainers (DPO and similar) read
  manifest.json     counts by task, source and label, and a fingerprint of the data
Nothing here trains anything or contacts anything.
  .local\\replay-venv\\Scripts\\python.exe integrations\\model-eval\\build_dataset.py
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys

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

JOURNAL = ROOT / '.local' / 'model-calls'
EVALS = ROOT / '.local' / 'model-eval'
OUT = ROOT / '.local' / 'training-data'
AWAITING_OUTCOME = ('scenario', 'allocator')


def task_of(system):
    """Which organisation task a system prompt belongs to (None for anything else)."""
    # exact prompts first, then phrases only one task's prompt contains (the debate and R&D prompts both begin "You are the")
    exact = {claims.SYSTEM: 'claims', rnd_ideas.SYSTEM: 'rnd', playbook_drafts.SYSTEM: 'playbook', headline_reader.SYSTEM: 'headline'}
    if system in exact:
        return exact[system]
    if 'your call turned out wrong' in system:
        return 'reflect'
    if 'researcher on the debate desk' in system:
        return 'debate'
    if 'one voice on a panel that rehearses' in system:
        return 'scenario'
    if system.startswith(ai_allocator.SYSTEM[:80]):
        return 'allocator'
    return None


def label(task, user, answer):
    """('good', None) | ('fixable', corrected answer, reasons) | ('bad', None, reasons) | ('awaiting-outcome', None) for one answer."""
    payload = json.loads(user)
    if task in AWAITING_OUTCOME:
        return 'awaiting-outcome', None, []
    if task == 'claims':
        if not claims.valid_shape(answer):
            return 'bad', None, ['invalid shape']
        obs = {'title': payload['title'], 'content': payload['text'], 'publishedAt': payload['publishedAt']}
        kept, reasons = [], []
        for c in answer['claims']:
            why = claims.verify(c, obs)
            if why:
                reasons += why
            else:
                kept.append(c)
        return ('good', None, []) if not reasons else ('fixable', {'claims': kept}, sorted(set(reasons)))
    if task == 'debate':
        if not (isinstance(answer, dict) and isinstance(answer.get('argument'), str) and 20 <= len(answer['argument'].strip()) <= 600):
            return 'bad', None, ['invalid shape']
        if answer.get('evidenceId') is not None and answer['evidenceId'] not in payload.get('verifiedEvidenceIds', []):
            return 'fixable', {**answer, 'evidenceId': None}, ['cited evidence it may not cite']
        return 'good', None, []
    if task == 'rnd':
        ideas = answer.get('ideas') if isinstance(answer, dict) else None
        if not isinstance(ideas, list):
            return 'bad', None, ['invalid shape']
        catalogue = {rnd_ideas.spec_hash(s) for s in rnd_scout.CATALOGUE_SPECS.values()}
        kept, reasons = [], []
        for idea in ideas:
            spec = {k: v for k, v in idea.items() if k != 'why'} if isinstance(idea, dict) else idea
            if isinstance(spec, dict) and spec.get('filter') is None:
                spec.pop('filter', None)
            try:
                h = rnd_ideas.spec_hash(spec)
            except (ValueError, TypeError):
                reasons.append('invalid idea'); continue
            if h in catalogue:
                reasons.append('copied a catalogue idea'); continue
            kept.append(idea)
        return ('good', None, []) if not reasons else ('fixable', {'ideas': kept}, sorted(set(reasons)))
    if task == 'playbook':
        if not (isinstance(answer, dict) and answer.get('decidedBy') in ('agents', 'owner') and isinstance(answer.get('fix'), str)):
            return 'bad', None, ['invalid shape']
        fixed, reasons = dict(answer), []
        if answer['decidedBy'] == 'agents' and playbook_drafts.OWNER_ONLY.search(answer['fix']):
            fixed['decidedBy'] = 'owner'; reasons.append('a money or limits fix given to the agents')
        safe = playbook_drafts.safe_pattern(str(answer.get('text', '')), payload['lastFailureText'])
        if safe != answer.get('text'):
            fixed['text'] = safe; reasons.append('a pattern that does not match the failure')
        return ('good', None, []) if not reasons else ('fixable', fixed, reasons)
    if task == 'headline':
        if headline_reader.checked(answer) is None:
            return 'bad', None, ['invalid shape']
        return ('good', None, []) if len(str(answer.get('summary', ''))) <= 140 else ('fixable', headline_reader.checked(answer), ['summary too long'])
    if task == 'reflect':
        lesson = answer.get('lesson') if isinstance(answer, dict) else None
        return ('good', None, []) if isinstance(lesson, str) and 10 <= len(lesson.strip()) <= 200 else ('bad', None, ['invalid shape'])
    return 'bad', None, ['unknown task']


def exchanges(journal=JOURNAL, evals=EVALS):
    """(source, system, user, answer) for every recorded call that produced an answer."""
    for path in sorted(Path(journal).glob('*.jsonl')) if Path(journal).exists() else []:
        for line in path.read_text(encoding='utf-8').splitlines():
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if e.get('answer') is not None:
                yield 'production', e['system'], e['user'], e['answer']
    for path in sorted(Path(evals).glob('*/results.jsonl')) if Path(evals).exists() else []:
        for line in path.read_text(encoding='utf-8').splitlines():
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if e.get('answer') is not None and e.get('system'):
                yield 'evaluation', e['system'], e['user'], e['answer']


def build(journal=JOURNAL, evals=EVALS, out=OUT):
    seen, counts, files = set(), {}, {}
    for source, system, user, answer in exchanges(journal, evals):
        task = task_of(system)
        if task is None:
            continue
        digest = hashlib.sha256(json.dumps([system, user, answer], sort_keys=True).encode()).hexdigest()
        if digest in seen:
            continue
        seen.add(digest)
        verdict, corrected, reasons = label(task, user, answer)
        bucket = counts.setdefault(task, {}).setdefault(source, {})
        bucket[verdict] = bucket.get(verdict, 0) + 1
        prompt = [{'role': 'system', 'content': system}, {'role': 'user', 'content': user}]
        # evaluation rows come from invented fixtures: they go to eval-only/, never into a training file (Soup review)
        folder = 'eval-only' if source == 'evaluation' else task
        name = f'{task}-{{}}' if source == 'evaluation' else '{}'
        if verdict == 'good':
            files.setdefault((folder, name.format('sft')), []).append({'source': source,
                'messages': prompt + [{'role': 'assistant', 'content': json.dumps(answer, ensure_ascii=False)}]})
        elif verdict == 'fixable':
            files.setdefault((folder, name.format('preference')), []).append({'source': source, 'prompt': prompt, 'reasons': reasons,
                'chosen': [{'role': 'assistant', 'content': json.dumps(corrected, ensure_ascii=False)}],
                'rejected': [{'role': 'assistant', 'content': json.dumps(answer, ensure_ascii=False)}]})
        elif verdict == 'bad' and source == 'production':
            # an unusable answer is still a lesson: a KTO-style 'undesirable' example (no corrected version exists)
            files.setdefault((task, 'kto'), []).append({'source': source, 'prompt': prompt, 'reasons': reasons, 'label': False,
                'completion': [{'role': 'assistant', 'content': json.dumps(answer, ensure_ascii=False)}]})
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    written = {}
    for (folder, kind), rows in sorted(files.items()):
        (out / folder).mkdir(exist_ok=True)
        text = '\n'.join(json.dumps(r, ensure_ascii=False) for r in rows) + '\n'
        (out / folder / f'{kind}.jsonl').write_text(text, encoding='utf-8')
        written[f'{folder}/{kind}.jsonl'] = {'rows': len(rows), 'sha256': hashlib.sha256(text.encode()).hexdigest()[:16]}
    manifest = {'counts': counts, 'files': written, 'awaitingOutcome': list(AWAITING_OUTCOME),
                'fingerprint': hashlib.sha256(json.dumps(written, sort_keys=True).encode()).hexdigest()[:16],
                'note': 'Labelled by the organisation\'s own checks. <task>/sft.jsonl: chat messages; <task>/preference.jsonl: '
                        'prompt/chosen/rejected (chosen is the same answer corrected by the check); <task>/kto.jsonl: unusable answers '
                        'labelled undesirable. Rows from evaluation runs (invented fixtures) are only in eval-only/ and never in a '
                        'training file. Shuffle before training: Soup takes its validation split from the end of a file.'}
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    return manifest


def main(argv=None):
    argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter).parse_args(argv)
    m = build()
    for task, sources in m['counts'].items():
        print(f'  {task:9s} ' + '; '.join(f"{s}: " + ', '.join(f'{k} {v}' for k, v in c.items()) for s, c in sources.items()))
    for name, f in m['files'].items():
        print(f'  -> {name}: {f["rows"]} rows')
    print(f"Training data in {OUT} (fingerprint {m['fingerprint']}).")


if __name__ == '__main__':
    main()
