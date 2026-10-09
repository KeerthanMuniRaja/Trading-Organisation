"""Prepare stable unverified evidence and a factual lesson draft; never approve."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import sys
from experience import digest, load_bounded, packet


def prepare(folder, source_id):
    if not re.fullmatch(r'[a-zA-Z0-9_-]{1,80}', source_id):
        raise ValueError('INVALID_SOURCE_ID')
    folder = Path(folder)
    current = packet(load_bounded(folder/'dataset.json'), load_bounded(folder/'report.json'))
    saved = load_bounded(folder/'experience.json')
    if digest(current) != digest(saved):
        raise ValueError('EXPERIENCE_PACKET_MISMATCH')
    content = json.dumps({
        'kind': 'replay-experience-v1', 'sourceId': source_id,
        'provenance': 'local-computation-not-provider-published-analysis',
        'datasetProvider': current['source'], 'experienceId': current['id'],
        'datasetSha256': current['datasetSha256'], 'reportSha256': current['reportSha256'],
        'simulatorSha256': current['simulatorSha256'], 'facts': current['facts'],
        'limitations': current['limitations'], 'reviewStatus': 'unverified',
    }, sort_keys=True, separators=(',', ':'), allow_nan=False)
    if len(content) > 4000:
        raise ValueError('EVIDENCE_TOO_LONG')
    facts = {f['key']: f['value'] for f in current['facts']}
    lesson = (f"Observation from replay {current['reportSha256']}: "
              f"realised net {facts['realised-net-paise']} paise; "
              f"unrealised mark {facts['unrealised-net-paise']} paise; "
              f"{facts['closed-trades']} closed simulated trades. "
              "These results apply only to the stored sample and illustrative costs. "
              "They do not establish a profitable strategy, causal explanation, model learning or trading authority. "
              "Reproduction used the same simulator; independent review is still required.")
    target = folder / f'evidence-submission-{source_id}.json'
    stable = {'sourceId': source_id, 'kind': 'dataset', 'content': content}
    if target.exists():
        evidence = load_bounded(target)
        if set(evidence) != {*stable, 'publishedAt'} or any(evidence[k] != v for k, v in stable.items()):
            raise ValueError('SUBMISSION_CONFLICT')
        t = datetime.fromisoformat(evidence['publishedAt'])
        if t.utcoffset() is None or t > datetime.now(timezone.utc):
            raise ValueError('INVALID_SUBMISSION_TIME')
    else:
        evidence = {**stable, 'publishedAt': datetime.now(timezone.utc).isoformat()}
        with target.open('x', encoding='utf-8') as handle:
            json.dump(evidence, handle, sort_keys=True)
    return {'evidence': evidence, 'lessonContent': lesson, 'experienceId': current['id']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('run', type=Path)
    parser.add_argument('source_id')
    args = parser.parse_args()
    try:
        print(json.dumps(prepare(args.run, args.source_id), allow_nan=False))
    except Exception:
        print('Replay evidence preparation failed; artifacts must match the current simulator and saved packet.', file=sys.stderr)
        sys.exit(1)
