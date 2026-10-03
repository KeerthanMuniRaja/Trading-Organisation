"""Bounded research/evaluation worker. No trading tools, code execution, or self-modification."""
from __future__ import annotations

import argparse
from datetime import datetime
from decimal import Decimal, localcontext
import json
import os
import time
from urllib.parse import urlparse
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError, URLError

VERSION = "momentum-lab-v1"


def validate_bars(bars: list[dict]) -> None:
    if not isinstance(bars, list) or not bars or len(bars) > 2020:
        raise ValueError("Invalid bar count")
    previous = None
    for bar in bars:
        if set(bar) != {"timestamp", "closePaise"}:
            raise ValueError("Unexpected bar fields")
        amount = bar["closePaise"]
        if not isinstance(amount, str) or not amount.isascii() or not amount.isdigit() or not 0 < int(amount) < 10**14:
            raise ValueError("Price must be positive integer paise")
        instant = datetime.fromisoformat(bar["timestamp"].replace("Z", "+00:00"))
        if instant.tzinfo is None or (previous is not None and instant <= previous):
            raise ValueError("Bars must be strictly chronological with timezone")
        previous = instant


def backtest(bars: list[dict], lookback: int, cost_bps: int, warmup: list[dict] | None = None) -> dict:
    """Prior-close signals drive the NEXT interval; no future prices enter a signal.

    Fractional normalised exposure and constant costs are research assumptions,
    not a venue fill simulator. Final liquidation costs are included.
    """
    if isinstance(lookback, bool) or not isinstance(lookback, int) or not 2 <= lookback <= 20:
        raise ValueError("Unsupported lookback")
    if not isinstance(cost_bps, int) or not 1 <= cost_bps <= 1000:
        raise ValueError("Invalid cost assumption")
    warmup = warmup or []
    validate_bars(bars)
    if warmup:
        validate_bars(warmup)
    combined = warmup + bars
    validate_bars(combined)
    with localcontext() as ctx:
        ctx.prec = 40
        prices = [Decimal(b["closePaise"]) for b in combined]
        equity = peak = Decimal(1)
        drawdown = Decimal(0)
        position = turnover = 0
        cost = Decimal(cost_bps) / 10000
        for current in range(len(warmup), len(prices)):
            previous = current - 1
            target = int(previous >= lookback and prices[previous] > prices[previous - lookback])
            if target != position:
                equity *= 1 - cost
                turnover += 1
            if target and current > 0:
                equity *= prices[current] / prices[previous]
            position = target
            peak = max(peak, equity)
            drawdown = max(drawdown, 1 - equity / peak)
        if position:
            equity *= 1 - cost
            turnover += 1
            drawdown = max(drawdown, 1 - equity / peak)
        return {
            "observations": len(bars),
            "netReturnBps": round(float((equity - 1) * 10000), 6),
            "baselineReturnBps": 0.0,
            "maxDrawdownBps": round(float(drawdown * 10000), 6),
            "turnover": turnover,
            "costBps": cost_bps,
        }


def research(payload: dict) -> dict:
    trials = []
    for lookback in (2, 5, 10, 20):
        result = backtest(payload["training"], lookback, payload["costBps"])
        trials.append({"lookback": lookback, "netReturnBps": result["netReturnBps"]})
    winner = max(trials, key=lambda item: (item["netReturnBps"], -item["lookback"]))
    return {"candidate": {"kind": "momentum", "lookback": winner["lookback"]},
            "trainingReport": {"selectedScoreBps": winner["netReturnBps"], "trials": trials}}


def evaluate(payload: dict) -> dict:
    candidate = payload["candidate"]
    if set(candidate) != {"kind", "lookback"} or candidate["kind"] != "momentum":
        raise ValueError("Unsupported candidate plugin")
    result = backtest(payload["holdout"], candidate["lookback"], payload["costBps"], payload["warmup"])
    result["datasetDigest"] = payload["datasetDigest"]
    return result


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Worker API redirects are forbidden")


class Client:
    def __init__(self, base: str, token: str):
        parsed = urlparse(base)
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("Invalid API origin")
        if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost", "::1"}):
            raise ValueError("HTTPS required except for loopback development")
        if len(token) < 43:
            raise ValueError("A scoped API token is required")
        self.base, self.token = base.rstrip("/"), token
        self.opener = build_opener(NoRedirect())

    def post(self, path: str, body: dict, key: str | None = None) -> dict:
        # Claims return an existing active lease for this identity; completions
        # have stable keys. Both are safe to retry after a lost response.
        deadline = time.monotonic() + 20
        for attempt in range(4):
            try:
                return self._send(path, body, key, min(5, max(0.1, deadline - time.monotonic())))
            except HTTPError as error:
                if error.code not in {429, 500, 502, 503, 504}:
                    raise
                retry_after = error.headers.get("Retry-After", "") if error.headers else ""
                delay = min(float(retry_after), 10) if retry_after.isdigit() else min(2 ** attempt, 8)
                if attempt == 3 or time.monotonic() + delay >= deadline:
                    raise
            except (URLError, TimeoutError, OSError):
                delay = min(2 ** attempt, 8)
                if attempt == 3 or time.monotonic() + delay >= deadline:
                    raise
            time.sleep(delay)
        raise RuntimeError("Retry budget exhausted")

    def _send(self, path: str, body: dict, key: str | None, timeout: float) -> dict:
        headers = {"Content-Type": "application/json", "Authorization": "Bearer " + self.token}
        if key:
            headers["Idempotency-Key"] = key
        req = Request(self.base + path, data=json.dumps(body, allow_nan=False).encode(), headers=headers, method="POST")
        with self.opener.open(req, timeout=timeout) as response:
            content = response.read(1024 * 1024 + 1)
            if len(content) > 1024 * 1024:
                raise ValueError("API response exceeds worker limit")
            return json.loads(content)


def run_once(client: Client, role: str) -> bool:
    job = client.post("/v1/jobs/claims", {}).get("job")
    if job is None:
        return False
    expected = "research" if role == "researcher" else "evaluation"
    if job["kind"] != expected:
        raise ValueError("Role and job do not match")
    result = research(job["payload"]) if role == "researcher" else evaluate(job["payload"])
    body = {"jobId": job["id"], "leaseToken": job["leaseToken"], "result": result}
    # All retries use the same key and exact result. Never claim a new job on a lost completion response.
    key = "completion-" + job["id"] + "-" + job["leaseToken"]
    client.post("/v1/jobs/completions", body, key)
    print(json.dumps({"event": "job.completed", "jobId": job["id"], "role": role, "workerVersion": VERSION}))
    return True


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--role", choices=("researcher", "evaluator"), required=True)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    client = Client(os.environ.get("API_URL", "http://127.0.0.1:3000"), os.environ.get("API_TOKEN", ""))
    while True:
        try:
            worked = run_once(client, args.role)
        except HTTPError as error:
            if args.once or error.code not in {429, 500, 502, 503, 504}:
                raise
            print(json.dumps({"event": "worker.connection.delayed", "status": error.code}))
            time.sleep(10)
            continue
        except (URLError, TimeoutError, OSError):
            if args.once:
                raise
            print(json.dumps({"event": "worker.connection.delayed"}))
            time.sleep(10)
            continue
        if args.once:
            break
        if not worked:
            time.sleep(5)


if __name__ == "__main__":
    main()
