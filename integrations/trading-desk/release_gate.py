"""Release gate: a research bot asks the backend whether its exact version is authorised before it runs.

The backend's release registry (POST /v1/releases/check) authorises one active release per bot plus any canaries. A
version is the model name, the prompt fingerprint and a fingerprint of the code that turns model output into decisions.
For the allocator that code is ai_allocator.py and portfolio_daily.py (decisions and simulation); curriculum.py only
builds the prompt, which the prompt fingerprint already covers.
  .local\\replay-venv\\Scripts\\python.exe integrations\\trading-desk\\release_gate.py --bot allocator --model Qwen3.5-4B-Q4_K_M --prompt-version 0634b9cf839d47d2
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
ALLOCATOR_CODE = ('ai_allocator.py', 'portfolio_daily.py')


def code_fingerprint(files=ALLOCATOR_CODE, root=HERE):
    """Line-ending independent hash of the decision code, so Windows and Linux checkouts agree."""
    digest = hashlib.sha256()
    for name in files:
        digest.update(name.encode() + b'\0' + (root / name).read_bytes().replace(b'\r\n', b'\n') + b'\0')
    return digest.hexdigest()[:32]


def check(bot_id, model, prompt_version, env=os.environ, opener=None, files=ALLOCATOR_CODE):
    """Returns the backend's answer; raises PermissionError when the version is not authorised."""
    from urllib import request as urlrequest
    from urllib.error import HTTPError, URLError
    import signals_bridge  # reuse the backend origin and credential rules
    base, token = signals_bridge.credential(env, bot_id) if any(
        p.get('botId') == bot_id for p in json.loads(env.get('PRINCIPALS_JSON') or '[]')) else researcher(env)
    body = json.dumps({'botId': bot_id, 'model': model, 'promptVersion': prompt_version, 'codeFingerprint': code_fingerprint(files)}).encode()
    req = urlrequest.Request(base + '/v1/releases/check', data=body, method='POST',
                             headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    try:
        with (opener or urlrequest.urlopen)(req, timeout=15) as response:
            answer = json.loads(response.read(65537))
    except HTTPError as error:
        error.close()
        raise PermissionError(f'Release check refused (HTTP {error.code})') from None
    except (URLError, OSError, ValueError):
        raise PermissionError('Release check unavailable; not running an unverified version') from None
    if not answer.get('allowed'):
        raise PermissionError(f"Version not authorised for {bot_id}: {answer.get('reason')}")
    return answer


def researcher(env):
    import re
    values = {k: env.get(k) for k in ('API_URL', 'PRINCIPALS_JSON')}
    base = (values['API_URL'] or 'http://127.0.0.1:3000').rstrip('/')
    if not re.match(r'^(https://[^/@?#]+|http://(127\.0\.0\.1|localhost)(:\d+)?)$', base):
        raise ValueError('Invalid backend API origin')
    found = [p for p in json.loads(values['PRINCIPALS_JSON'] or '[]') if p.get('role') == 'researcher']
    if len(found) != 1 or not found[0].get('token'):
        raise ValueError('Configure exactly one researcher credential')
    return base, found[0]['token']


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--bot', required=True)
    parser.add_argument('--model', required=True)
    parser.add_argument('--prompt-version', required=True)
    parser.add_argument('--fingerprint-only', action='store_true', help='Print the code fingerprint to register a release, then exit')
    args = parser.parse_args(argv)
    if args.fingerprint_only:
        print(code_fingerprint())
        return
    print(json.dumps(check(args.bot, args.model, args.prompt_version), indent=2))


if __name__ == '__main__':
    sys.path.insert(0, str(HERE))
    try:
        main()
    except (PermissionError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
