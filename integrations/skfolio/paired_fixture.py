"""Isolated integration fixture: deliberately broken cost solver versus existing solver.

This is a regression demonstration, not a learned improvement or production candidate.
"""
import hashlib
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from services.research.worker import Client
from skills import producer, solve
from paired import run_pair


def manifests():
    source = Path(__file__).read_bytes().replace(b"\r\n", b"\n")
    return {"baseline": {"name": "deliberate-cost-error-fixture", "version": "1", "kind": "deterministic",
                         "sourceSha256": hashlib.sha256(source).hexdigest()}, "candidate": producer()}


def broken_costs(challenge):
    result = solve(challenge)
    result["netProfitPaise"] = challenge["grossProfitPaise"]
    return result


if __name__ == "__main__":
    declarations = manifests()
    if sys.argv[1:] == ["--manifests"]:
        print(json.dumps(declarations))
    elif len(sys.argv) == 2:
        client = Client(os.environ["API_URL"], os.environ["API_TOKEN"])
        print(json.dumps(run_pair(client, sys.argv[1], declarations["baseline"], broken_costs,
                                  declarations["candidate"], solve)))
    else:
        raise SystemExit("Use --manifests or an isolated fixture experiment ID")
