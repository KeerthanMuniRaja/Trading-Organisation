"""One owner-budgeted Hermes R&D proposal, with durable no-regeneration recovery."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys

from adapter import Settings, HermesError, PINNED_REVISION, propose_capability, validate_capability, verify_checkout
_spec = importlib.util.spec_from_file_location('development_http_client', Path(__file__).resolve().parents[2] / 'services' / 'research' / 'worker.py')
_http = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_http)
Client = _http.Client


@contextmanager
def locked(path):
    with path.open('a+b') as handle:
        if os.name == 'nt':
            import msvcrt
            if handle.tell() == 0:
                handle.write(b'0'); handle.flush()
            handle.seek(0); msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield
        finally:
            if os.name == 'nt':
                handle.seek(0); msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def save(path, record):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(record, allow_nan=False), encoding='utf-8')
    os.replace(temporary, path)


def run_once(client, settings, dataset_id, method, request_key, directory, proposer=propose_capability):
    directory.mkdir(parents=True, exist_ok=True)
    identity = {'base': client.base, 'datasetId': dataset_id, 'method': method, 'requestKey': request_key,
                'principalFingerprint': hashlib.sha256(client.token.encode()).hexdigest()}
    stable = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    path = directory / (stable + '.json')
    with locked(directory / 'run.lock'):
        if path.exists():
            record = json.loads(path.read_text(encoding='utf-8'))
            if record['identity'] != identity:
                raise HermesError('Saved R&D identity differs')
        else:
            ticket = client.post('/v1/development/requests', {'datasetId': dataset_id, 'method': method}, request_key)
            record = {'identity': identity, 'ticket': ticket, 'inferenceStarted': False}
            save(path, record)
        ticket = record['ticket']
        profile = ticket['model']
        if (profile['name'] != settings.model or profile['baseUrl'].rstrip('/') != settings.base_url.rstrip('/')
                or profile['sourceRevision'] != PINNED_REVISION or profile['engine'] != 'hermes-rd-v1'):
            raise HermesError('Local Hermes settings differ from owner-approved model profile')
        if 'proposal' not in record:
            if record['inferenceStarted']:
                raise HermesError('Previous inference outcome uncertain; do not regenerate it automatically')
            if datetime.fromisoformat(ticket['expiresAt'].replace('Z', '+00:00')) <= datetime.now(timezone.utc):
                raise HermesError('R&D request expired before inference')
            client.post('/v1/development/preflight', {'requestId': ticket['id']})
            record['inferenceStarted'] = True
            save(path, record)
            record['proposal'] = proposer(settings, ticket['context'])
            save(path, record)
        proposal = validate_capability(record['proposal'], ticket['context'])
        return client.post('/v1/development/proposals', {'requestId': ticket['id'], 'contextHash': ticket['contextHash'],
            'proposal': proposal}, 'development-submit-' + stable)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dataset-id', required=True)
    parser.add_argument('--method', required=True, choices=('equal_weight', 'inverse_volatility', 'minimum_variance'))
    parser.add_argument('--request-key', required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9_-]{8,100}', args.request_key):
        parser.error('Use a stable 8-100 character request key')
    settings = Settings.from_env(); verify_checkout(settings)
    client = Client(os.environ.get('API_URL', 'http://127.0.0.1:3000'), os.environ.get('API_TOKEN', ''))
    directory = Path(__file__).resolve().parent / '.state' / 'development'
    print(json.dumps(run_once(client, settings, args.dataset_id, args.method, args.request_key, directory)))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'event': 'development.failed', 'message': 'R&D failed or needs reconciliation; reuse the same request key. No recruitment occurred.'}), file=sys.stderr)
        raise SystemExit(1)
