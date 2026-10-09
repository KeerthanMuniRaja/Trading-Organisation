"""One-time, owner-run download of Kronos weights into .local/kronos/weights, with a record of what was fetched.

The only network step of the forecast analyst. Everything afterwards loads these local copies offline, so the
desk keeps working even if the upstream repositories change or disappear. Re-running skips existing copies.
Run with the Kronos environment: .local\\kronos-venv\\Scripts\\python.exe integrations\\trading-desk\\kronos_weights.py
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import forecast  # noqa: E402

PUBLISHER = 'NeoQuasar'  # the Hugging Face organisation named in the Kronos README


def fetch(variant):
    from huggingface_hub import HfApi, snapshot_download
    record = {}
    for repo in (variant, forecast.VARIANTS[variant][0]):
        target = forecast.KRONOS / 'weights' / repo
        if target.exists() and any(target.iterdir()):
            record[repo] = {'state': 'already-present', 'digest': forecast.weights_digest(target)}
            continue
        revision = HfApi().model_info(f'{PUBLISHER}/{repo}').sha  # pin the exact snapshot downloaded
        snapshot_download(f'{PUBLISHER}/{repo}', revision=revision, local_dir=str(target),
                          allow_patterns=['*.json', '*.safetensors', '*.md'])
        record[repo] = {'state': 'downloaded', 'revision': revision, 'digest': forecast.weights_digest(target)}
    ledger = forecast.KRONOS / 'weights' / 'downloads.json'
    history = json.loads(ledger.read_text(encoding='utf-8')) if ledger.exists() else []
    history.append({'at': datetime.now(timezone.utc).isoformat(), 'variant': variant, 'repos': record})
    ledger.write_text(json.dumps(history, indent=2), encoding='utf-8')
    return record


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--variant', default='Kronos-mini', choices=sorted(forecast.VARIANTS))
    args = parser.parse_args(argv)
    print(json.dumps(fetch(args.variant), indent=2))


if __name__ == '__main__':
    main()
