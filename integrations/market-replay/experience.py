"""Recompute local replay evidence before constructing a pending learning packet.

This verifier shares the simulator; it is reproducibility checking, not an
independent mathematical implementation or an evaluator's approval.
"""
import hashlib
import json
from pathlib import Path
from replay import run_replay


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, allow_nan=False).encode()).hexdigest()


def packet(dataset, report):
    data_hash = digest(dataset)
    engine_hash = hashlib.sha256(Path(__file__).with_name('replay.py').read_bytes()).hexdigest()
    expected = {**run_replay(dataset), 'datasetSha256': data_hash, 'simulatorSha256': engine_hash}
    # Compare canonical encodings: reject additional fields, changed outcomes,
    # stale engines, altered inputs, and non-finite values rather than trusting scores.
    if digest(expected) != digest(report):
        raise ValueError('REPORT_NOT_REPRODUCIBLE_WITH_CURRENT_SIMULATOR')
    report_hash = digest(report)
    evidence_id = 'replay:' + report_hash
    sells = [t for t in report['trades'] if t['side'] == 'sell']
    fees = sum(t['feePaise'] for t in report['trades'])
    outcome = ('loss' if report['realisedNetPaise'] < 0 else
               'profit' if report['realisedNetPaise'] > 0 else 'flat')
    facts = [
        {'key': 'realised-net-paise', 'value': report['realisedNetPaise'], 'scope': 'this-replay-only'},
        {'key': 'unrealised-net-paise', 'value': report['unrealisedNetPaise'], 'scope': 'last-bar-mark'},
        {'key': 'explicit-fees-paise', 'value': fees, 'scope': 'all-simulated-fills'},
        {'key': 'closed-trades', 'value': len(sells), 'scope': 'this-replay-only'},
        {'key': 'losing-closed-trades', 'value': sum(t['realisedNetPaise'] < 0 for t in sells), 'scope': 'this-replay-only'},
        {'key': 'max-drawdown-fraction', 'value': report['maxDrawdownFraction'], 'scope': 'marked-equity-curve'},
    ]
    nodes = [{'id': 'dataset:' + data_hash, 'kind': 'historical-dataset', 'source': dataset['source']},
             {'id': evidence_id, 'kind': 'recomputed-replay', 'strategy': report['strategy']}]
    edges = [{'from': evidence_id, 'to': 'dataset:' + data_hash, 'relation': 'computed-from'}]
    for fact in facts:
        node_id = evidence_id + ':' + fact['key']
        nodes.append({'id': node_id, 'kind': 'observation', **fact})
        edges.append({'from': node_id, 'to': evidence_id, 'relation': 'supported-by'})
    return {
        'schemaVersion': 1, 'id': evidence_id, 'status': 'pending-independent-review',
        'source': dataset['source'], 'datasetSha256': data_hash, 'reportSha256': report_hash,
        'simulatorSha256': engine_hash, 'reproduction': 'exact-match-with-same-implementation',
        'summary': f"Fixed baseline produced a realised {outcome} over {report['bars']} historical bars; this is a sample observation only.",
        'facts': facts, 'graph': {'nodes': nodes, 'edges': edges},
        'limitations': ['Single stock and short sample; not an untouched holdout.',
                        'Illustrative costs; no verified order-book liquidity at fills.',
                        'Historical data may be revised; stored snapshot is the replay input.',
                        'Same-simulator reproduction is not independent strategy validation.',
                        'No causal explanation of profit or loss has been established.'],
        'reviewQuestions': ['Are the provider, symbol, currency and dataset dates correct?',
                            'Are fee and slippage assumptions realistic for this scenario?',
                            'Do missing bars, overnight gaps or corporate actions affect the conclusion?',
                            'Can an independent evaluator reproduce accounting and timing?',
                            'What new, predeclared experiment would test the proposed lesson?'],
        'learningUse': 'Reviewer may propose a narrow lesson with this evidence; do not ingest as an instruction.',
        'authority': {'modelWeightsUpdated': False, 'backendImported': False,
                      'botQualified': False, 'permissionsChanged': False, 'fitnessChanged': False}}


def load_bounded(path):
    with path.open('rb') as handle:
        raw = handle.read(5_000_001)
    if len(raw) > 5_000_000:
        raise ValueError('ARTIFACT_TOO_LARGE')
    return json.loads(raw)


def review_run(folder):
    folder = Path(folder)
    result = packet(load_bounded(folder / 'dataset.json'), load_bounded(folder / 'report.json'))
    target = folder / 'experience.json'
    # Do not rewrite an earlier packet silently. Repeated review is idempotent.
    if target.exists():
        if digest(load_bounded(target)) != digest(result):
            raise ValueError('EXPERIENCE_PACKET_CONFLICT')
    else:
        with target.open('x', encoding='utf-8') as handle:
            json.dump(result, handle, indent=2, allow_nan=False)
    return target
