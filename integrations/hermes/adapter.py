"""Hermes proposes a bounded research candidate; the backend retains all authority."""
from __future__ import annotations

import contextvars
from dataclasses import dataclass, field
import json
import math
import os
import re
from pathlib import Path
import subprocess
import tempfile
from urllib.parse import urlsplit

import contracts

PINNED_REVISION = "f97608f178d1ffeca59860195ab7da295f7c8e5f"
RELEASE = "v2026.9.24"
MAX_OUTPUT_BYTES = 4096
# Leave time within the 120-second lease for two 10-second checkout checks and
# the shared client's 20-second completion retry budget.
TIMEOUT_SECONDS = 70


class HermesError(RuntimeError):
    """Intentionally generic: do not expose provider responses or secrets in logs."""


def strict_json(text: str):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise HermesError("Duplicate JSON key")
            result[key] = value
        return result

    def invalid_constant(value):
        raise HermesError("Non-finite JSON value")

    try:
        return json.loads(text, object_pairs_hook=pairs, parse_constant=invalid_constant)
    except (ValueError, TypeError) as exc:
        raise HermesError("Hermes must return strict JSON") from exc


def validate_candidate(candidate: dict) -> dict:
    if not isinstance(candidate, dict) or set(candidate) != {"kind", "lookback"}:
        raise HermesError("Candidate fields do not match the approved research contract")
    lookback = candidate["lookback"]
    if candidate["kind"] != "momentum" or type(lookback) is not int or not 2 <= lookback <= 20:
        raise HermesError("Candidate is outside the approved research bounds")
    return {"kind": "momentum", "lookback": lookback}


def validate_trial_summary(trials: list[dict]) -> None:
    if not isinstance(trials, list) or len(trials) != 19:
        raise HermesError("Expected all 19 approved training trials")
    if {item.get("lookback") for item in trials if isinstance(item, dict)} != set(range(2, 21)):
        raise HermesError("Training trial coverage does not match")
    for item in trials:
        if set(item) != {"lookback", "netReturnBps", "maxDrawdownBps", "turnover"}:
            raise HermesError("Unexpected training trial fields")
        if type(item["lookback"]) is not int or type(item["turnover"]) is not int or item["turnover"] < 0:
            raise HermesError("Invalid training trial counters")
        for field in ("netReturnBps", "maxDrawdownBps"):
            if type(item[field]) not in (int, float) or not math.isfinite(item[field]):
                raise HermesError("Invalid training metric")


@dataclass(frozen=True)
class Settings:
    source: Path
    python: Path
    model: str
    base_url: str
    api_key: str = field(repr=False)
    timeout_seconds: int = contracts.DEFAULT_TIMEOUT_SECONDS
    engine: str = 'hermes'

    @classmethod
    def from_env(cls, env=None) -> "Settings":
        env = os.environ if env is None else env
        if env.get("HERMES_ENABLED") != "true":
            raise HermesError("Set HERMES_ENABLED=true explicitly to use this optional worker")
        engine = env.get("HERMES_ENGINE", "hermes")
        if engine not in ENGINES:
            raise HermesError("HERMES_ENGINE must be hermes or direct")
        # The direct engine runs no upstream agent code, so it needs no Hermes checkout or interpreter.
        names = ("HERMES_MODEL", "HERMES_MODEL_BASE_URL", "HERMES_MODEL_API_KEY") + (("HERMES_SOURCE_PATH", "HERMES_PYTHON") if engine == "hermes" else ())
        if any(not env.get(name, "").strip() for name in names):
            raise HermesError("Model, endpoint and model key (plus Hermes source and Python for the hermes engine) are required")
        parsed = urlsplit(env["HERMES_MODEL_BASE_URL"])
        if not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise HermesError("Model endpoint must not contain credentials, query or fragment")
        if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}):
            raise HermesError("Model endpoint requires HTTPS except on loopback")
        if len(env["HERMES_MODEL"]) > 200 or len(env["HERMES_MODEL_API_KEY"]) > 4096:
            raise HermesError("Hermes configuration exceeds its limits")
        # Slow local hardware may need longer than the original 70 s; each task stays capped by its ticket lifetime.
        raw_timeout = env.get("HERMES_TIMEOUT_SECONDS", str(contracts.DEFAULT_TIMEOUT_SECONDS))
        if not raw_timeout.isdigit() or not 70 <= int(raw_timeout) <= 540:
            raise HermesError("HERMES_TIMEOUT_SECONDS must be an integer from 70 to 540")
        source = Path(env["HERMES_SOURCE_PATH"]).resolve() if engine == "hermes" else Path("unused-by-direct-engine")
        python = Path(env["HERMES_PYTHON"]).resolve() if engine == "hermes" else Path("unused-by-direct-engine")
        return cls(source, python, env["HERMES_MODEL"], env["HERMES_MODEL_BASE_URL"], env["HERMES_MODEL_API_KEY"], int(raw_timeout), engine)


# Local engine name -> backend profile engine. A ticket is only served by the engine its owner policy names.
ENGINES = {'hermes': 'hermes-rd-v1', 'direct': 'direct-structured-v1'}
# Collects provider usage for the current inference; set by inference_reporting.timed_inference.
USAGE = contextvars.ContextVar('organisation_inference_usage', default=None)


def profile_matches(profile: dict, settings: Settings) -> bool:
    if profile.get('name') != settings.model or str(profile.get('baseUrl', '')).rstrip('/') != settings.base_url.rstrip('/'):
        return False
    if profile.get('engine') != ENGINES[settings.engine]:
        return False
    return settings.engine == 'direct' or profile.get('sourceRevision') == PINNED_REVISION


def engine_label(settings: Settings) -> str:
    return 'direct-structured-v1' if settings.engine == 'direct' else 'hermes-' + PINNED_REVISION[:12]


def verify_checkout(settings: Settings) -> None:
    if settings.engine == 'direct':
        return  # No upstream checkout is executed by the direct engine.
    if not settings.python.is_file() or not (settings.source / "run_agent.py").is_file():
        raise HermesError("Hermes Python environment or source checkout is missing")
    # run_agent loads a source-local .env even when HERMES_HOME is separate.
    if (settings.source / ".env").exists() or (settings.source / "config.yaml").exists():
        raise HermesError("Use a dedicated Hermes source checkout without local credentials or config")
    try:
        # Both commands are local reads. Do not inherit Git credential helpers,
        # token variables, custom git directories, or personal configuration.
        with tempfile.TemporaryDirectory(prefix="trading-hermes-git-") as directory:
            environment = {key: os.environ[key] for key in ("PATH", "SYSTEMROOT", "SystemRoot", "WINDIR", "PATHEXT") if key in os.environ}
            environment.update({"HOME": directory, "USERPROFILE": directory, "GIT_CONFIG_NOSYSTEM": "1",
                                "GIT_CONFIG_GLOBAL": os.devnull, "GIT_TERMINAL_PROMPT": "0",
                                "GIT_OPTIONAL_LOCKS": "0", "GIT_NO_REPLACE_OBJECTS": "1"})
            command = ["git", "--no-pager", "-c", "core.fsmonitor=false", "-c", "credential.helper=",
                       "-c", "credential.interactive=false", "-c", "core.hooksPath=" + directory,
                       "-C", str(settings.source)]
            revision = subprocess.run(command + ["rev-parse", "HEAD"], env=environment,
                                      check=True, capture_output=True, text=True, timeout=10).stdout.strip()
            changes = subprocess.run(command + ["status", "--porcelain", "--untracked-files=normal"], env=environment,
                                     check=True, capture_output=True, text=True, timeout=10).stdout.strip()
    except (OSError, subprocess.SubprocessError) as exc:
        raise HermesError("Cannot verify the Hermes source checkout") from exc
    if revision != PINNED_REVISION or changes:
        raise HermesError("Hermes must use the clean, pinned source revision")


def child_environment(settings: Settings, home: Path, inherited=None, timeout: int = contracts.DEFAULT_TIMEOUT_SECONDS) -> dict:
    inherited = os.environ if inherited is None else inherited
    # Deliberately do not inherit API_TOKEN, PRINCIPALS_JSON, database URLs, proxy
    # settings, PYTHONPATH, other provider credentials, or the user's Hermes home.
    environment = {key: inherited[key] for key in ("SYSTEMROOT", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL") if key in inherited}
    environment.update({"PATH": str(settings.python.parent), "HOME": str(home), "USERPROFILE": str(home),
                        "HERMES_HOME": str(home), "TMPDIR": str(home), "TMP": str(home), "TEMP": str(home),
                        "HERMES_MODEL_API_KEY": settings.api_key,
                        "PYTHONIOENCODING": "utf-8", "HERMES_API_CALL_TIMEOUT": str(contracts.agent_budgets(timeout)["api"])})
    return environment


def propose(settings: Settings, trials: list[dict]) -> dict:
    validate_trial_summary(trials)
    request = {"source": str(settings.source), "model": settings.model, "baseUrl": settings.base_url, "trials": trials}
    return invoke(settings, request, validate_candidate)


def validate_capability(value: dict, context: dict) -> dict:
    if not isinstance(value, dict) or set(value) != {"specialty", "method", "hypothesis", "expectedContribution", "risks", "memoryIds"}:
        raise HermesError("Unexpected capability proposal fields")
    if not isinstance(value['specialty'], str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', value['specialty']):
        raise HermesError("Invalid specialty")
    if value['method'] != context['method']:
        raise HermesError("Proposal method differs from its authorised context")
    for field in ('hypothesis', 'expectedContribution'):
        if not isinstance(value[field], str) or not 1 <= len(value[field].strip()) <= 500:
            raise HermesError("Invalid proposal text")
    risks = value['risks']
    if not isinstance(risks, list) or not 1 <= len(risks) <= 5 or any(not isinstance(r, str) or not 1 <= len(r.strip()) <= 200 for r in risks):
        raise HermesError("A bounded risk account is required")
    refs = value['memoryIds']
    allowed = {m['id'] for m in context['memories']}
    if (not isinstance(refs, list) or not 1 <= len(refs) <= 10 or any(not isinstance(r, str) for r in refs)
            or len(set(refs)) != len(refs) or not set(refs).issubset(allowed)):
        raise HermesError("Proposal must cite supplied memory")
    return value


def propose_capability(settings: Settings, context: dict) -> dict:
    if (not isinstance(context, dict) or set(context) != {'datasetId', 'method', 'beforeTrainingEnd', 'memories', 'existingCapabilities'}
            or context['method'] not in {'equal_weight', 'inverse_volatility', 'minimum_variance'}
            or not isinstance(context['memories'], list) or not 1 <= len(context['memories']) <= 10
            or not isinstance(context['existingCapabilities'], list) or len(context['existingCapabilities']) > 100
            or len(json.dumps(context).encode('utf-8')) > 48000):
        raise HermesError("Invalid bounded development context")
    for memory in context['memories']:
        if not isinstance(memory, dict) or set(memory) != {'id', 'content'} or not all(isinstance(v, str) for v in memory.values()):
            raise HermesError("Unexpected memory fields")
    request = {'source': str(settings.source), 'model': settings.model, 'baseUrl': settings.base_url,
               'task': 'capability', 'context': context}
    return invoke(settings, request, lambda value: validate_capability(value, context))


def direct_invoke(settings: Settings, request: dict, validator) -> dict:
    """One schema-constrained chat completion: no agent loop, tools or upstream code. Validators still decide acceptance."""
    from openai_compat import Endpoint, EndpointError, chat
    task = contracts.task_name(request)
    try:
        endpoint = Endpoint.create(settings.base_url, settings.model, settings.api_key)
        result = chat(endpoint, contracts.PROMPTS[task], json.dumps(contracts.user_payload(task, request), allow_nan=False),
                      contracts.MAX_TOKENS[task], timeout=contracts.timeout_for(task, settings.timeout_seconds),
                      schema=contracts.output_schema(task, request.get('context')))
    except EndpointError as exc:
        raise HermesError('Model endpoint failed: ' + exc.code) from None
    sink = USAGE.get()
    if sink is not None:
        sink.update({k: result[k] for k in ('promptTokens', 'completionTokens', 'reportedModel') if result[k] is not None})
    if len(result['content'].encode('utf-8')) > MAX_OUTPUT_BYTES:
        raise HermesError('Model output exceeds the research contract')
    return validator(strict_json(result['content']))


def invoke(settings: Settings, request: dict, validator) -> dict:
    if settings.engine == 'direct':
        return direct_invoke(settings, request, validator)
    verify_checkout(settings)
    timeout = contracts.timeout_for(contracts.task_name(request), settings.timeout_seconds)
    request = {**request, 'timeoutSeconds': timeout}
    with tempfile.TemporaryDirectory(prefix="trading-hermes-") as directory:
        home = Path(directory)
        (home / "config.yaml").write_text("{}\n", encoding="utf-8")
        # A temporary file bounds what we read into memory and avoids passing
        # upstream stdout/stderr or provider diagnostics into backend logs.
        with tempfile.TemporaryFile() as output:
            try:
                completed = subprocess.run([str(settings.python), "-I", str(Path(__file__).with_name("runner.py"))],
                                           input=json.dumps(request, allow_nan=False).encode("utf-8"), stdout=output,
                                           stderr=subprocess.DEVNULL, env=child_environment(settings, home, timeout=timeout),
                                           cwd=home, timeout=timeout, check=False, shell=False)
            except (OSError, subprocess.SubprocessError) as exc:
                raise HermesError("Hermes research subprocess failed or timed out") from exc
            if completed.returncode != 0:
                raise HermesError("Hermes failed; verify the isolated installation and provider configuration")
            output.seek(0)
            encoded = output.read(MAX_OUTPUT_BYTES + 1)
            if len(encoded) > MAX_OUTPUT_BYTES:
                raise HermesError("Hermes output exceeds the research contract")
    try:
        candidate = strict_json(encoded.decode("utf-8"))
    except UnicodeError as exc:
        raise HermesError("Hermes output must be UTF-8 JSON") from exc
    return validator(candidate)
