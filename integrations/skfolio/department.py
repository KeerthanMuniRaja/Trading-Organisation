"""One department cycle. The launcher supplies one role and a finite runtime."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from services.research.worker import Client


def run_once(client, role):
    if role == "researcher":
        remediation = client.post("/v1/skills/remediation/cycles", {}, "department-remediation-" + uuid4().hex)
        from skills import examine
        skills = examine(client, "department-skills-" + uuid4().hex)
        learning = client.post("/v1/learning/cycles", {}, "department-learn-" + uuid4().hex)
        # Import and verify dependencies before taking a time-limited lease.
        from bridge import submit, verify_dependencies
        verify_dependencies()
        claimed = client.post("/v1/dispatch/claims", {}, "dispatch-claim-" + uuid4().hex)
        assignment = claimed.get("assignment")
        if assignment is None:
            return {"role": role, "status": claimed["status"], "learning": learning, "skills": skills, "remediation": remediation}
        memory = client.post("/v1/learning/memory", {"datasetId": assignment["datasetId"], "method": assignment["method"]})
        result = submit(client, assignment["botId"], assignment["datasetId"], assignment["method"],
                        assignment={"id": assignment["id"], "leaseToken": assignment["leaseToken"]})
        return {"role": role, "status": "submitted", "assignmentId": assignment["id"], "trialId": result["id"],
                "learning": learning, "skills": skills, "remediation": remediation, "availableMemoryCount": len(memory["items"]), "memoryUsedForFitting": False}
    # No model, fitted weights or researcher credential is needed to request review.
    skills = client.post("/v1/skills/cycles", {}, "department-skills-" + uuid4().hex)
    remediation = client.post("/v1/skills/remediation/cycles", {}, "department-remediation-" + uuid4().hex)
    reviewed = []
    for trial in client.post("/v1/dispatch/reviews", {})["trials"]:
        trial_id = trial["trialId"]
        client.post("/v1/portfolio/reviews", {"trialId": trial_id}, "department-review-" + trial_id)
        reviewed.append(trial_id)
    learning = client.post("/v1/learning/cycles", {}, "department-learn-" + uuid4().hex)
    experiments = client.post("/v1/development/experiments/cycles", {}, "department-experiment-" + uuid4().hex)
    lifecycle = client.post("/v1/lifecycle/cycles", {}, "department-life-" + uuid4().hex)
    dispatch = client.post("/v1/dispatch/cycles", {}, "department-dispatch-" + uuid4().hex)
    return {"role": role, "status": dispatch["status"], "reviewed": reviewed,
            "lifecycle": lifecycle, "assignments": dispatch["assignments"], "learning": learning, "experiments": experiments, "skills": skills, "remediation": remediation}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("role", choices=("researcher", "evaluator"))
    args = parser.parse_args()
    client = Client(os.environ.get("API_URL", "http://127.0.0.1:3000"), os.environ.get("API_TOKEN", ""))
    try:
        print(json.dumps(run_once(client, args.role), allow_nan=False))
    except Exception as error:
        # Avoid dumping requests, credentials, training observations or lease tokens.
        print(json.dumps({"role": args.role, "status": "error", "errorType": type(error).__name__}), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
