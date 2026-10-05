"""Trusted source fixtures for real artifact execution and lost-response replay."""
import hashlib
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import sys

from artifact_executor import run_verified_pair
from artifact_batch import recover_batch
from artifact_inspection import inspect_journal

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from services.research.worker import Client


def prepare(directory):
    original = Path(__file__).with_name("skills.py").read_bytes().replace(b"\r\n", b"\n").decode()
    baseline = original + "\n_original_solve = solve\ndef solve(c):\n    result = _original_solve(c)\n    result['netProfitPaise'] = c['grossProfitPaise']\n    return result\n"
    result = {}
    for arm, source in (("baseline", baseline), ("candidate", original)):
        folder = directory / arm
        folder.mkdir(parents=True, exist_ok=True)
        raw = source.encode()
        (folder / "solver.py").write_bytes(raw)
        producer = {"name": "artifact-fixture-" + arm, "version": "1", "kind": "deterministic",
                    "sourceSha256": hashlib.sha256(raw).hexdigest()}
        (folder / "artifact.json").write_text(json.dumps({"producer": producer, "sourceFile": "solver.py"}), encoding="utf-8")
        result[arm] = producer
    return result


class LostResponseClient(Client):
    lose = True

    def post(self, path, body, key=None):
        response = super().post(path, body, key)
        if path.endswith("/submissions") and self.lose:
            self.lose = False
            raise OSError("Deliberate loss after actual backend acceptance")
        return response


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--prepare":
        print(json.dumps(prepare(Path(sys.argv[2]))))
    elif len(sys.argv) == 3:
        experiment, directory = sys.argv[1], Path(sys.argv[2])
        client = LostResponseClient(os.environ["API_URL"], os.environ["API_TOKEN"])
        args = (client, experiment, directory / "baseline/artifact.json", directory / "candidate/artifact.json", directory / "state")
        try:
            run_verified_pair(*args, trusted_local=True, report_execution=True)
            raise AssertionError("Expected injected lost response")
        except OSError:
            pass
        journal = next((directory / 'state').glob('*.sqlite')).stem
        before = inspect_journal(client, journal, directory / 'state')
        assert before['localStatus'] == 'submission-saved-unconfirmed'
        assert before['nextAction'] == 'recover-saved-submission'
        batch = recover_batch(client, [journal], directory / 'state')
        assert batch['needsAttention'] == 0 and batch['executedArtifacts'] == 0
        recovery = batch['results'][0]
        assert recovery['status'] == 'submitted' and recovery['executedArtifacts'] == 0
        after = inspect_journal(client, journal, directory / 'state')
        assert after['localStatus'] == 'acknowledgement-saved' and after['queuedReports'] == 0
        result = run_verified_pair(*args, trusted_local=True, report_execution=True)
        historical = run_verified_pair(*args, trusted_local=True, report_execution=True)
        with closing(sqlite3.connect(directory / "state" / (result["journal"] + ".sqlite"))) as db:
            receipts = [json.loads(row[0]) for row in db.execute("SELECT receipt FROM attempts WHERE state='completed'")]
            count = db.execute("SELECT count(*) FROM attempts").fetchone()[0]
            lost = db.execute("SELECT count(*) FROM events WHERE kind='submission-unconfirmed'").fetchone()[0]
        assert count == 2 and len(receipts) == 2 and lost == 1 and historical["historicalReceipt"]
        print(json.dumps({**result, "recovery": recovery, "executions": count, "unconfirmedSubmissions": lost,
                          "sourceHashes": [r["sourceSha256"] for r in receipts],
                          "isolation": "trusted-local-process-only", "remoteAttestation": False}))
    else:
        raise SystemExit("Use --prepare DIRECTORY or EXPERIMENT DIRECTORY")
