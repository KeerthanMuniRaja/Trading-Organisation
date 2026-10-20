"""Readiness checks for the configured model endpoint. No backend credentials are read or sent.

Default checks only list served models. `--probe` performs one tiny completion; a non-loopback
endpoint additionally needs `--allow-remote-cost` because hosted providers may bill it.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from adapter import HermesError, PINNED_REVISION, Settings, strict_json, verify_checkout  # noqa: E402
import contracts  # noqa: E402
from openai_compat import Endpoint, EndpointError, chat, list_models  # noqa: E402

PROBE_SYSTEM = 'You are a connectivity probe. You have no tools. Return exactly {"ok":true} and nothing else.'


def diagnose(env, *, probe=False, allow_remote_cost=False, check_hermes=False, opener=None) -> dict:
    checks = []
    def record(name, ok, code=None, **details):
        checks.append({'name': name, 'ok': ok, **({'code': code} if code else {}), **details})
        return ok
    try:
        endpoint = Endpoint.create(env.get('HERMES_MODEL_BASE_URL', ''), env.get('HERMES_MODEL', ''), env.get('HERMES_MODEL_API_KEY', ''))
    except EndpointError as exc:
        record('settings', False, exc.code)
        return {'status': 'attention', 'checks': checks}
    record('settings', True, origin=endpoint.origin, loopback=endpoint.loopback, model=endpoint.model)
    try:
        served = list_models(endpoint, opener=opener)
        record('model-served', endpoint.model in served, None if endpoint.model in served else 'MODEL_NOT_SERVED', servedCount=len(served))
    except EndpointError as exc:
        record('model-served', False, exc.code)
    if probe:
        if not endpoint.loopback and not allow_remote_cost:
            record('probe', False, 'REMOTE_COST_NOT_ACKNOWLEDGED')
        else:
            try:
                result = chat(endpoint, PROBE_SYSTEM, '{}', 16, timeout=60, opener=opener)
                try:
                    strict = strict_json(result['content']) == {'ok': True}
                except HermesError:
                    strict = False
                record('probe', True, latencyMs=result['latencyMs'], strictJson=strict,
                       usageReported=result['promptTokens'] is not None and result['completionTokens'] is not None,
                       reportedModel=result['reportedModel'])
            except EndpointError as exc:
                record('probe', False, exc.code)
    if check_hermes:
        try:
            settings = Settings.from_env(env)
            verify_checkout(settings)
            same = settings.model == endpoint.model and settings.base_url.rstrip('/') == endpoint.base_url
            record('hermes-checkout', same, None if same else 'HERMES_SETTINGS_DIFFER', revision=PINNED_REVISION)
        except HermesError:
            record('hermes-checkout', False, 'HERMES_NOT_READY')
    return {'status': 'ready' if all(c['ok'] for c in checks) else 'attention', 'checks': checks,
            'promptVersions': {t: contracts.prompt_version(t) for t in contracts.PROMPTS},
            'scope': 'Endpoint readiness only; not model quality, weight attestation or activation.'}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--probe', action='store_true')
    parser.add_argument('--allow-remote-cost', action='store_true')
    parser.add_argument('--check-hermes', action='store_true')
    args = parser.parse_args(argv)
    report = diagnose(os.environ, probe=args.probe, allow_remote_cost=args.allow_remote_cost, check_hermes=args.check_hermes)
    print(json.dumps(report, indent=2))
    return 0 if report['status'] == 'ready' else 1


if __name__ == '__main__':
    raise SystemExit(main())
