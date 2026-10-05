"""Deterministic research-basics examination adapter, not a language model."""
from datetime import datetime
import hashlib
import json
from pathlib import Path


def producer():
    source = Path(__file__).read_bytes().replace(b"\r\n", b"\n")
    return {"name": "research-basics-python", "version": "1", "kind": "deterministic",
            "sourceSha256": hashlib.sha256(source).hexdigest()}


def producer_hash(manifest):
    return hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def solve(challenge):
    equity = challenge["equityPaise"]
    peak, maximum = equity[0], 0.0
    for value in equity:
        peak = max(peak, value)
        maximum = max(maximum, (1 - value / peak) * 10000)
    cutoff = datetime.fromisoformat(challenge["cutoff"].replace("Z", "+00:00"))
    records = [record["id"] for record in challenge["records"] if all(
        datetime.fromisoformat(record[field].replace("Z", "+00:00")) <= cutoff
        for field in ("eventAt", "availableAt"))]
    control = challenge["control"]
    allowed = (not control["halted"] and control["evidenceVerified"]
               and control["budget"] >= control["required"])
    return {"netProfitPaise": challenge["grossProfitPaise"] - challenge["feesPaise"] - challenge["slippagePaise"],
            "maxDrawdownBps": maximum, "eligibleRecordIds": records,
            "action": "research" if allowed else "wait"}


def examine(client, key):
    manifest = producer()
    fingerprint = producer_hash(manifest)
    claimed = client.post("/v1/skills/claims", {"producer": manifest}, key)
    attempt = claimed.get("attempt")
    if attempt is None:
        return {"status": claimed["status"]}
    if attempt["rubric"] != "research-basics-v1":
        raise ValueError("Unsupported skill rubric")
    if attempt.get("producerHash") != fingerprint:
        raise ValueError("Attempt producer does not match this worker declaration")
    result = client.post("/v1/skills/submissions",
                         {"attemptId": attempt["id"], "answers": solve(attempt["challenge"]), "producerHash": fingerprint},
                         "skills-submit-" + attempt["id"])
    return {"status": result["state"], "attemptId": attempt["id"]}
