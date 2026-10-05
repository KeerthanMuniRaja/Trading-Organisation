"""Paired academy protocol for trusted, caller-supplied solvers; no artifact loader."""
from copy import deepcopy
from skills import producer_hash


def run_pair(client, experiment_id, baseline_manifest, baseline_solve, candidate_manifest, candidate_solve):
    identity = {"experimentId": experiment_id, "baselineHash": producer_hash(baseline_manifest),
                "candidateHash": producer_hash(candidate_manifest)}
    if identity["baselineHash"] == identity["candidateHash"]:
        raise ValueError("Different producer declarations required")
    work = client.post("/v1/skills/experiments/work", identity, "paired-work-" + experiment_id)
    if any(work.get(field) != value for field, value in identity.items()) or work.get("rubric") != "research-basics-v1":
        raise ValueError("Paired plan does not match this worker")
    cases = work["cases"]
    if not 8 <= len(cases) <= 32 or len({case["id"] for case in cases}) != len(cases):
        raise ValueError("Invalid paired case set")
    results = []
    for case in cases:
        # Separate copies keep a mutating solver from changing its partner's inputs.
        baseline = deepcopy(baseline_solve(deepcopy(case["challenge"])))
        candidate = deepcopy(candidate_solve(deepcopy(case["challenge"])))
        results.append({"caseId": case["id"], "baseline": baseline, "candidate": candidate})
    return client.post("/v1/skills/experiments/submissions",
                       {**identity, "planHash": work["planHash"], "results": results},
                       "paired-submit-" + experiment_id)
