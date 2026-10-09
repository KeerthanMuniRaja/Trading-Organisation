"""Minimal OpenAI-compatible client for diagnostics, benchmarks and direct inference. Stdlib only.

The direct engine is distinct from the pinned Hermes adapter. This client never follows
redirects, ignores ambient proxy settings, bounds every response and never echoes provider text or keys.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import ipaddress
import json
import socket
import time
from urllib import request as urlrequest
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit

MAX_RESPONSE_BYTES = 262144


class EndpointError(RuntimeError):
    """Carries a fixed code only; provider bodies and exception text are discarded."""
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def is_loopback(hostname: str) -> bool:
    if hostname == 'localhost':
        return True
    try:
        return ipaddress.ip_address(hostname.strip('[]')).is_loopback
    except ValueError:
        return False


@dataclass(frozen=True)
class Endpoint:
    base_url: str
    model: str
    api_key: str = field(repr=False)

    @classmethod
    def create(cls, base_url: str, model: str, api_key: str) -> 'Endpoint':
        if not base_url or not model:
            raise EndpointError('ENDPOINT_NOT_CONFIGURED')
        parsed = urlsplit(base_url)
        if not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise EndpointError('ENDPOINT_URL_INVALID')
        if parsed.scheme != 'https' and not (parsed.scheme == 'http' and is_loopback(parsed.hostname)):
            raise EndpointError('ENDPOINT_REQUIRES_HTTPS')
        if not isinstance(model, str) or not 1 <= len(model) <= 200 or not isinstance(api_key, str) or not 1 <= len(api_key) <= 4096:
            raise EndpointError('ENDPOINT_SETTINGS_INVALID')
        return cls(base_url.rstrip('/'), model, api_key)

    @property
    def loopback(self) -> bool:
        return is_loopback(urlsplit(self.base_url).hostname or '')

    @property
    def origin(self) -> str:
        parsed = urlsplit(self.base_url)
        return f'{parsed.scheme}://{parsed.netloc}'


class _NoRedirect(urlrequest.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise EndpointError('ENDPOINT_REDIRECT_REFUSED')


# Empty ProxyHandler: HTTP(S)_PROXY variables are ignored so the key goes only to the configured origin.
_OPENER = urlrequest.build_opener(urlrequest.ProxyHandler({}), _NoRedirect())


def _call(endpoint: Endpoint, method: str, path: str, body=None, timeout: float = 30.0, opener=None):
    data = None if body is None else json.dumps(body, allow_nan=False).encode('utf-8')
    req = urlrequest.Request(endpoint.base_url + path, data=data, method=method, headers={
        'Authorization': 'Bearer ' + endpoint.api_key, 'Accept': 'application/json',
        **({'Content-Type': 'application/json'} if data is not None else {})})
    started = time.perf_counter()
    try:
        with (opener or _OPENER).open(req, timeout=timeout) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except EndpointError:
        raise
    except HTTPError as exc:
        exc.close()
        code = {401: 'ENDPOINT_UNAUTHORISED', 403: 'ENDPOINT_UNAUTHORISED', 404: 'ENDPOINT_NOT_FOUND',
                429: 'ENDPOINT_RATE_LIMITED'}.get(exc.code, 'ENDPOINT_HTTP_ERROR')
        raise EndpointError(code) from None
    except (socket.timeout, TimeoutError):
        raise EndpointError('ENDPOINT_TIMEOUT') from None
    except URLError as exc:
        raise EndpointError('ENDPOINT_TIMEOUT' if isinstance(exc.reason, (socket.timeout, TimeoutError)) else 'ENDPOINT_UNREACHABLE') from None
    except (OSError, ValueError):
        raise EndpointError('ENDPOINT_UNREACHABLE') from None
    latency_ms = round((time.perf_counter() - started) * 1000, 1)
    if len(raw) > MAX_RESPONSE_BYTES:
        raise EndpointError('ENDPOINT_RESPONSE_TOO_LARGE')
    try:
        return json.loads(raw.decode('utf-8')), latency_ms
    except (UnicodeError, ValueError):
        raise EndpointError('ENDPOINT_RESPONSE_INVALID') from None


def list_models(endpoint: Endpoint, timeout: float = 15.0, opener=None) -> list[str]:
    value, _ = _call(endpoint, 'GET', '/models', timeout=timeout, opener=opener)
    data = value.get('data') if isinstance(value, dict) else None
    if not isinstance(data, list) or len(data) > 1000:
        raise EndpointError('ENDPOINT_RESPONSE_INVALID')
    return sorted({item['id'] for item in data if isinstance(item, dict) and isinstance(item.get('id'), str) and len(item['id']) <= 200})


def _count(value):
    return value if type(value) is int and 0 <= value <= 10_000_000 else None


def chat(endpoint: Endpoint, system: str, user: str, max_tokens: int, timeout: float = 60.0, opener=None, schema=None) -> dict:
    """One non-streaming completion at temperature 0. Returns content plus usage when the server reports it."""
    body = {'model': endpoint.model, 'temperature': 0, 'stream': False, 'max_tokens': max_tokens,
            'messages': [{'role': 'system', 'content': system}, {'role': 'user', 'content': user}]}
    if schema is not None:
        # OpenAI-style structured output; llama.cpp compiles it to a decoding grammar.
        body['response_format'] = {'type': 'json_schema', 'json_schema': {'name': 'organisation_contract', 'strict': True, 'schema': schema}}
    value, latency_ms = _call(endpoint, 'POST', '/chat/completions', body, timeout=timeout, opener=opener)
    try:
        choice = value['choices'][0]
        message = choice['message']
        content = message['content']
    except (KeyError, IndexError, TypeError):
        raise EndpointError('ENDPOINT_RESPONSE_INVALID') from None
    if not isinstance(content, str):
        raise EndpointError('ENDPOINT_RESPONSE_INVALID')
    usage = value.get('usage') if isinstance(value.get('usage'), dict) else {}
    reported = value.get('model')
    return {'content': content, 'latencyMs': latency_ms,
            'hasToolCalls': bool(message.get('tool_calls') or message.get('function_call')),
            'refused': bool(message.get('refusal')),
            'finishReason': choice.get('finish_reason') if isinstance(choice.get('finish_reason'), str) else None,
            'promptTokens': _count(usage.get('prompt_tokens')), 'completionTokens': _count(usage.get('completion_tokens')),
            'reportedModel': reported if isinstance(reported, str) and len(reported) <= 200 else None}
