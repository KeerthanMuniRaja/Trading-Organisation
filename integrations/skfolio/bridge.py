"""One bounded backend portfolio operation with one role-scoped API token."""
from __future__ import annotations

import argparse
from datetime import datetime
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import sys

import numpy as np
import pandas as pd

from lab import HERE, METHODS, exclusive_run, replace_report, validate_weights, weights_for

sys.path.insert(0, str(HERE.parents[1]))
from services.research.worker import Client


def sha(value):
    return hashlib.sha256(value.encode()).hexdigest()


def verify_dependencies():
    content = (HERE / "dependencies.lock.json").read_text(encoding="utf-8")
    for package in json.loads(content)["packages"]:
        if importlib.metadata.version(package["name"]) != package["version"]:
            raise ValueError("Dependency version differs from reviewed lock")
    return sha(content)


def training_frame(payload):
    if set(payload) != {"datasetId", "datasetDigest", "assets", "training", "purpose", "costBps", "weightCap", "methods"}:
        raise ValueError("Unexpected portfolio training contract; no holdout may enter fitting")
    if (payload["purpose"] != "example-testing" or payload["costBps"] != 15
            or payload["weightCap"] != .25 or tuple(payload["methods"]) != METHODS):
        raise ValueError("Portfolio policy differs from this worker")
    if not re.fullmatch(r"[a-f0-9]{64}", payload["datasetDigest"]):
        raise ValueError("Invalid dataset digest")
    assets, rows = payload["assets"], payload["training"]
    if (not 4 <= len(assets) <= 20 or len(set(assets)) != len(assets)
            or not all(re.fullmatch(r"[A-Z][A-Z0-9._-]{0,19}", a) for a in assets)
            or not 60 <= len(rows) <= 504):
        raise ValueError("Invalid asset or training dimensions")
    previous, matrix, dates = None, [], []
    for row in rows:
        if set(row) != {"timestamp", "returns"}:
            raise ValueError("Unexpected training fields")
        instant = datetime.fromisoformat(row["timestamp"].replace("Z", "+00:00"))
        if instant.tzinfo is None or (previous is not None and instant <= previous):
            raise ValueError("Training observations must be chronological")
        values = row["returns"]
        if len(values) != len(assets) or any(type(v) not in (float, int) or not np.isfinite(v) or not -1 < v <= 1 for v in values):
            raise ValueError("Invalid training return")
        matrix.append(values)
        dates.append(instant)
        previous = instant
    return pd.DataFrame(matrix, columns=assets, index=dates)


def submit(client, bot_id, dataset_id, method, state=None, assignment=None):
    if method not in METHODS or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", bot_id):
        raise ValueError("Invalid research identity or method")
    dependency_digest = verify_dependencies()
    payload = client.post("/v1/portfolio/training", {"datasetId": dataset_id})
    if payload["datasetId"] != dataset_id:
        raise ValueError("Training dataset identity mismatch")
    training = training_frame(payload)
    identity = {"base": client.base, "botId": bot_id, "datasetId": dataset_id, "method": method,
                "datasetDigest": payload["datasetDigest"], "dependencyDigest": dependency_digest}
    if assignment is not None:
        if set(assignment) != {"id", "leaseToken"}:
            raise ValueError("Invalid assignment contract")
        identity["assignmentId"] = assignment["id"]
    stable = sha(json.dumps(identity, sort_keys=True))
    directory = state or HERE / ".state" / "bridge"
    directory.mkdir(parents=True, exist_ok=True)
    with exclusive_run(directory / "run.lock"):
        saved = directory / (stable + ".json")
        if saved.exists():
            intent = json.loads(saved.read_text(encoding="utf-8"))
            if intent["identity"] != identity:
                raise ValueError("Saved submission identity mismatch")
            body = intent["body"]
        else:
            weights = weights_for(method, training)
            body = {"botId": bot_id, "datasetId": dataset_id, "datasetDigest": payload["datasetDigest"],
                    "method": method, "weights": weights.tolist()}
            intent = {"identity": identity, "body": body}
            temporary = saved.with_suffix(".tmp")
            temporary.write_text(json.dumps(intent, allow_nan=False), encoding="utf-8")
            replace_report(temporary, saved)
        if (set(body) != {"botId", "datasetId", "datasetDigest", "method", "weights"}
                or any(body[k] != identity[k] for k in ("botId", "datasetId", "datasetDigest", "method"))):
            raise ValueError("Saved submission contract mismatch")
        validate_weights(body["weights"], len(payload["assets"]))
        # Persisted exact body survives a lost response. Never refit on an uncertain submission.
        if assignment is not None:
            body = {**body, "assignment": assignment}
            # Retry leases reuse the fitted weights; each lease has its own receipt.
            return client.post("/v1/portfolio/trials", body, "assignment-" + sha(stable + assignment["leaseToken"]))
        return client.post("/v1/portfolio/trials", body, "portfolio-" + stable)


def review(client, trial_id):
    return client.post("/v1/portfolio/reviews", {"trialId": trial_id}, "portfolio-review-" + sha(trial_id))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("role", choices=("researcher", "evaluator"))
    parser.add_argument("--bot-id")
    parser.add_argument("--dataset-id")
    parser.add_argument("--method", choices=METHODS)
    parser.add_argument("--trial-id")
    args = parser.parse_args()
    client = Client(os.environ.get("API_URL", "http://127.0.0.1:3000"), os.environ.get("API_TOKEN", ""))
    if args.role == "researcher":
        if not all((args.bot_id, args.dataset_id, args.method)) or args.trial_id:
            parser.error("researcher requires --bot-id, --dataset-id, --method only")
        result = submit(client, args.bot_id, args.dataset_id, args.method)
    else:
        if not args.trial_id or any((args.bot_id, args.dataset_id, args.method)):
            parser.error("evaluator requires --trial-id only")
        result = review(client, args.trial_id)
    print(json.dumps(result, allow_nan=False))


if __name__ == "__main__":
    main()
