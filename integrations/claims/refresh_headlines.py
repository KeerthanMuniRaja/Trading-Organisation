"""Owner-started finite headline reconciliation. Read-only backend access; no model inference."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import time

import autolearn


def run(config, state, api, *, cycles=1, interval_seconds=120, sleep=time.sleep):
    if type(cycles) is not int or not 1 <= cycles <= 120:
        raise ValueError('cycles must be 1-120')
    if type(interval_seconds) is not int or not 60 <= interval_seconds <= 240:
        raise ValueError('interval-seconds must be 60-240')
    state.mkdir(parents=True, exist_ok=True)
    lock_path = state / 'headline-refresh.lock'
    try:
        lock = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        raise ValueError('A refresh worker holds this state; confirm it stopped before removing headline-refresh.lock') from None
    results = []
    try:
        os.write(lock, str(os.getpid()).encode())
        for index in range(cycles):
            record = {'cycle': index + 1, 'startedAt': datetime.now(timezone.utc).isoformat(),
                      'modelInvoked': False, 'backendMutations': False}
            try:
                # Prevent a future exporter change from silently adding write endpoints here.
                def read_api(method, route, body):
                    if method != 'POST' or route != '/v1/evidence/status':
                        raise ValueError('Refresh permits only evidence status lookup')
                    return api(method, route, body)
                record['headlines'] = len(autolearn.export_headlines(read_api, state, config))
                record['outcome'] = 'refreshed'
            except (ValueError, RuntimeError, OSError, KeyError, TypeError):
                autolearn.headline_receipt.receipt_path(state / 'verified-headlines.json').unlink(missing_ok=True)
                record['outcome'] = 'failed'
                record['reason'] = 'Reconciliation failed; inspect backend availability and local review state'
            autolearn.write(state, 'headline-refresh-status.json', record)
            results.append(record)
            if record['outcome'] == 'failed':
                break
            if index + 1 < cycles:
                sleep(interval_seconds)
    finally:
        os.close(lock)
        lock_path.unlink(missing_ok=True)
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--state', type=Path, default=autolearn.STATE)
    parser.add_argument('--cycles', type=int, default=1, choices=range(1, 121))
    parser.add_argument('--interval-seconds', type=int, default=120, choices=range(60, 241))
    args = parser.parse_args()
    config = autolearn.load_config(args.config)
    env = autolearn.child_env('refresh', dict(os.environ), autolearn.env_file(),
                             steps={'refresh': 'researcher'}, model_steps=())
    api = autolearn.child_backend(env, 'researcher')
    result = run(config, args.state, api, cycles=args.cycles, interval_seconds=args.interval_seconds)
    print(json.dumps(result, indent=2))
    return 1 if result[-1]['outcome'] == 'failed' else 0


if __name__ == '__main__':
    raise SystemExit(main())
