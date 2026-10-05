"""Optional Hermes researcher. An independent worker must evaluate the holdout."""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from adapter import HermesError, Settings, propose, validate_candidate, verify_checkout

_spec = importlib.util.spec_from_file_location("organisation_research_worker", Path(__file__).resolve().parents[2] / "services" / "research" / "worker.py")
base_worker = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(base_worker)


def research(payload: dict, settings: Settings, selector=propose) -> dict:
    if not isinstance(payload, dict) or set(payload) != {"training", "costBps"}:
        raise HermesError("Hermes may receive only the training partition and configured cost")
    trials = []
    for lookback in range(2, 21):
        metrics = base_worker.backtest(payload["training"], lookback, payload["costBps"])
        trials.append({"lookback": lookback, "netReturnBps": metrics["netReturnBps"],
                       "maxDrawdownBps": metrics["maxDrawdownBps"], "turnover": metrics["turnover"]})
    candidate = validate_candidate(selector(settings, trials))
    selected = next(item for item in trials if item["lookback"] == candidate["lookback"])
    # The LLM never supplies performance numbers. Every number is recomputed by
    # the local deterministic algorithm; the server schedules holdout evaluation.
    return {"candidate": candidate, "trainingReport": {
        "selectedScoreBps": selected["netReturnBps"],
        "trials": [{"lookback": item["lookback"], "netReturnBps": item["netReturnBps"]} for item in trials],
    }}


def run_once(client, settings: Settings, researcher=research) -> bool:
    job = client.post("/v1/jobs/claims", {}).get("job")
    if job is None:
        return False
    if job["kind"] != "research":
        raise HermesError("Hermes is authorised only for research jobs")
    result = researcher(job["payload"], settings)
    body = {"jobId": job["id"], "leaseToken": job["leaseToken"], "result": result}
    key = "completion-" + job["id"] + "-" + job["leaseToken"]
    # Client.post owns bounded transient-only retries of this same body/key.
    # A stale lease or forbidden principal fails immediately. Do not surround
    # this with another retry loop or regenerate output after a lost response.
    client.post("/v1/jobs/completions", body, key)
    print(json.dumps({"event": "job.completed", "jobId": job["id"], "role": "researcher", "workerVersion": "hermes-momentum-v1"}))
    return True


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--role", choices=("researcher",), default="researcher")
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    settings = Settings.from_env()
    verify_checkout(settings)  # Check before claiming a job; no default fallback.
    client = base_worker.Client(os.environ.get("API_URL", "http://127.0.0.1:3000"), os.environ.get("API_TOKEN", ""))
    while True:
        worked = run_once(client, settings)
        if args.once:
            break
        if not worked:
            time.sleep(5)


if __name__ == "__main__":
    try:
        main()
    except (HermesError, OSError, ValueError):
        print(json.dumps({"event": "hermes.failed", "message": "Optional Hermes research failed; no candidate accepted. Check configuration, installation and provider availability."}), file=sys.stderr)
        raise SystemExit(1)
