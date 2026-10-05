"""Live containment smoke check; requires a reviewed image already present locally."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import uuid
from datetime import datetime, timezone

from artifact_executor import Artifact
from artifact_sandbox import execute_sandbox, preflight


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    report = {"status": "blocked", "image": args.image, "checks": [], "remoteAttestation": False}
    code = 1
    try:
        preflight(args.image)
        report["status"] = "failed"
        source = Path(__file__).with_name("skills.py").read_bytes().replace(b"\r\n", b"\n").decode()
        probe = source + """
_normal_solve = solve
def solve(challenge):
    import socket
    try:
        with open('/paired-root-write-probe', 'w') as handle:
            handle.write('unexpected')
    except OSError:
        pass
    else:
        raise RuntimeError('Root filesystem unexpectedly writable')
    with socket.socket() as connection:
        connection.settimeout(0.2)
        try:
            connection.connect(('198.51.100.1', 9))
        except OSError:
            pass
        else:
            raise RuntimeError('Unexpected external connectivity')
    return _normal_solve(challenge)
"""
        manifest = {"name": "sandbox-containment-fixture", "version": "1", "kind": "deterministic",
                    "sourceSha256": hashlib.sha256(probe.encode()).hexdigest()}
        challenge = {"grossProfitPaise": 100, "feesPaise": 20, "slippagePaise": 5, "equityPaise": [10000, 9000],
                     "cutoff": "2020-01-01T00:00:00Z", "records": [],
                     "control": {"halted": True, "evidenceVerified": True, "budget": 10, "required": 10}}
        cases = [{"id": str(uuid.uuid4()), "challenge": challenge} for _ in range(8)]
        result = execute_sandbox(Artifact(manifest, probe), cases, image=args.image)
        assert all(r["answers"]["netProfitPaise"] == 75 and r["answers"]["action"] == "wait" for r in result["results"])
        report["checks"].append("effective privilege/filesystem/network/resource guard and solver contract passed")
        report["checks"].append("root write and external connection refused")
        slow = "import time\ndef solve(challenge):\n    time.sleep(60)\n"
        slow_manifest = {**manifest, "sourceSha256": hashlib.sha256(slow.encode()).hexdigest()}
        try:
            execute_sandbox(Artifact(slow_manifest, slow), cases, image=args.image, timeout=.5)
        except TimeoutError:
            report["checks"].append("timeout raised after confirmed container removal")
        else:
            raise RuntimeError("Expected timeout")
        report.update({"status": "passed", "pythonVersion": result["pythonVersion"], "sourceSha256": manifest["sourceSha256"]})
        code = 0
    except Exception as error:
        report["errorType"] = type(error).__name__
        report["reason"] = "Sandbox preflight unavailable or unsupported" if report["status"] == "blocked" else "Live containment check did not pass"
    report["finishedAt"] = datetime.now(timezone.utc).isoformat()
    output = root / ".local" / "artifact-sandbox-verification.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report))
    return code


if __name__ == "__main__":
    sys.exit(main())
