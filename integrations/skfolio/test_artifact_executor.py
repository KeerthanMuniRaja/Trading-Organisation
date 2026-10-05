import hashlib
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import uuid

from artifact_executor import load_artifact, execute_artifact, run_verified_pair, digest, exclusive
from test_skills import scenario

SOURCE = Path(__file__).with_name("skills.py").read_text(encoding="utf-8")


def artifact(root, name, source=SOURCE):
    folder = root / name
    folder.mkdir(exist_ok=True)
    raw = source.encode().replace(b"\r\n", b"\n")
    (folder / "solver.py").write_bytes(raw)
    descriptor = {"producer": {"name": name, "version": "1", "kind": "deterministic",
                               "sourceSha256": hashlib.sha256(raw).hexdigest()}, "sourceFile": "solver.py"}
    path = folder / "artifact.json"
    path.write_text(json.dumps(descriptor), encoding="utf-8")
    return path


def cases():
    return [{"id": str(uuid.uuid4()), "challenge": scenario()} for _ in range(8)]


class FakeClient:
    base = "http://127.0.0.1:39999"
    token = "ephemeral-fixture-token-" + "a" * 43

    def __init__(self, experiment, a, b, lose=False):
        self.work = {"experimentId": experiment, "baselineHash": digest(load_artifact(a).manifest),
                     "candidateHash": digest(load_artifact(b).manifest), "rubric": "research-basics-v1",
                     "planHash": "c" * 64, "cases": cases()}
        self.lose, self.saved, self.calls = lose, None, []

    def post(self, route, body, key):
        self.calls.append(route)
        if route.endswith("/work"):
            if self.saved:
                raise AssertionError("Accepted submission cannot fetch new work")
            return self.work
        if self.saved:
            if self.saved != (body, key):
                raise AssertionError("Retry payload changed")
        else:
            self.saved = (body, key)
        if self.lose:
            self.lose = False
            raise OSError("Simulated lost response")
        return {"experimentId": self.work["experimentId"], "status": "submitted"}


class ArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.a = artifact(self.root, "baseline")
        self.b = artifact(self.root, "candidate")

    def tearDown(self):
        self.temp.cleanup()

    def test_source_mismatch_and_path_escape_are_rejected_before_execution(self):
        self.a.with_name("solver.py").write_text("raise RuntimeError('changed')", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "fingerprint"):
            load_artifact(self.a)
        descriptor = json.loads(self.b.read_text())
        descriptor["sourceFile"] = "../solver.py"
        self.b.write_text(json.dumps(descriptor))
        with self.assertRaisesRegex(ValueError, "basename"):
            load_artifact(self.b)

    def test_no_execution_without_explicit_trusted_acknowledgement(self):
        with patch("artifact_executor.subprocess.Popen") as spawn:
            with self.assertRaises(ValueError):
                execute_artifact(load_artifact(self.a), cases())
            spawn.assert_not_called()

    def test_exact_snapshot_runs_even_if_source_path_changes_and_credentials_are_not_inherited(self):
        source = "import os\nassert 'API_TOKEN' not in os.environ\nassert 'PRINCIPALS_JSON' not in os.environ\nassert 'OPENAI_API_KEY' not in os.environ\n" + SOURCE
        path = artifact(self.root, "credential-check", source)
        snapshot = load_artifact(path)
        path.with_name("solver.py").write_text("raise RuntimeError('changed path')")
        with patch.dict(os.environ, {"API_TOKEN": "private-marker", "PRINCIPALS_JSON": "private-marker", "OPENAI_API_KEY": "private-marker"}):
            receipt = execute_artifact(snapshot, cases(), trusted_local=True)
        self.assertEqual(receipt["sourceSha256"], snapshot.manifest["sourceSha256"])
        self.assertEqual(receipt["results"][0]["answers"]["netProfitPaise"], -375)
        self.assertFalse(receipt["remoteAttestation"])

    def test_timeout_terminates_the_direct_solver(self):
        path = artifact(self.root, "slow", "import time\ndef solve(c):\n    time.sleep(60)\n")
        with self.assertRaises(TimeoutError):
            execute_artifact(load_artifact(path), cases(), trusted_local=True, timeout=.5)

    def test_output_flood_and_invalid_answers_are_rejected(self):
        loud = artifact(self.root, "loud", "print('x' * 200000)\ndef solve(c): return {}\n")
        with self.assertRaisesRegex(ValueError, "output exceeded"):
            execute_artifact(load_artifact(loud), cases(), trusted_local=True)
        invalid = artifact(self.root, "invalid", "def solve(c): return {'passed': True}\n")
        with self.assertRaisesRegex(ValueError, "answer shape"):
            execute_artifact(load_artifact(invalid), cases(), trusted_local=True)

    def test_lost_response_reuses_exact_saved_payload_without_running_either_artifact(self):
        experiment = str(uuid.uuid4())
        client = FakeClient(experiment, self.a, self.b, lose=True)
        state = self.root / "journal"
        with self.assertRaises(OSError):
            run_verified_pair(client, experiment, self.a, self.b, state, trusted_local=True)
        with patch("artifact_executor.execute_artifact", side_effect=AssertionError("must not run again")):
            result = run_verified_pair(client, experiment, self.a, self.b, state, trusted_local=True)
            self.assertEqual(result["status"], "submitted")
            self.assertFalse(result["historicalReceipt"])
            result = run_verified_pair(client, experiment, self.a, self.b, state, trusted_local=True)
            self.assertTrue(result["historicalReceipt"])
        dbfile = next(state.glob("*.sqlite"))
        with closing(sqlite3.connect(dbfile)) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM attempts").fetchone()[0], 2)
            self.assertEqual(db.execute("SELECT count(*) FROM events WHERE kind='submission-unconfirmed'").fetchone()[0], 1)
        self.assertNotIn(client.token.encode(), dbfile.read_bytes())

    def test_reporting_outage_preserves_submission_and_flushes_on_historical_replay(self):
        experiment = str(uuid.uuid4())
        client = FakeClient(experiment, self.a, self.b)
        original_post = client.post
        outage = True

        def post(route, body, key):
            if route.endswith('/execution-reports'):
                if outage:
                    raise OSError('Reporting unavailable')
                return {'experimentId': experiment, 'lastSequence': body['events'][-1]['sequence']}
            return original_post(route, body, key)

        client.post = post
        state = self.root / 'journal'
        result = run_verified_pair(client, experiment, self.a, self.b, state, trusted_local=True, report_execution=True)
        self.assertEqual(result['status'], 'submitted')
        self.assertEqual(result['executionReporting'], {'pending': 5, 'reported': False})
        outage = False
        with patch('artifact_executor.execute_artifact', side_effect=AssertionError('must not execute again')):
            replay = run_verified_pair(client, experiment, self.a, self.b, state, trusted_local=True, report_execution=True)
        self.assertTrue(replay['historicalReceipt'])
        self.assertEqual(replay['executionReporting'], {'pending': 0, 'reported': True})

    def test_failure_retry_limit_and_interrupted_attempt_history(self):
        experiment = str(uuid.uuid4())
        client = FakeClient(experiment, self.a, self.b)
        state = self.root / "journal"
        with patch("artifact_executor.execute_artifact", side_effect=RuntimeError("fixture failure")) as execute:
            for _ in range(2):
                with self.assertRaises(RuntimeError):
                    run_verified_pair(client, experiment, self.a, self.b, state, trusted_local=True)
            dbfile = next(state.glob("*.sqlite"))
            with closing(sqlite3.connect(dbfile)) as db:
                db.execute("UPDATE attempts SET state='running' WHERE id=2")
                db.commit()
            with self.assertRaisesRegex(ValueError, "retry budget"):
                run_verified_pair(client, experiment, self.a, self.b, state, trusted_local=True)
            self.assertEqual(execute.call_count, 2)
        with closing(sqlite3.connect(dbfile)) as db:
            self.assertEqual(db.execute("SELECT state FROM attempts ORDER BY id").fetchall(), [("failed",), ("interrupted",)])
        self.assertIsNone(client.saved)

    def test_completed_baseline_is_reused_when_candidate_retries(self):
        experiment = str(uuid.uuid4())
        client = FakeClient(experiment, self.a, self.b)
        state = self.root / "journal"
        calls = []

        def fail_candidate_once(artifact, cases, **options):
            calls.append(artifact.manifest["name"])
            if len(calls) == 2:
                raise RuntimeError("Candidate fixture interrupted")
            return execute_artifact(artifact, cases, **options)

        with patch("artifact_executor.execute_artifact", side_effect=fail_candidate_once):
            with self.assertRaises(RuntimeError):
                run_verified_pair(client, experiment, self.a, self.b, state, trusted_local=True)
            self.assertIsNone(client.saved)
            self.assertEqual(run_verified_pair(client, experiment, self.a, self.b, state, trusted_local=True)["status"], "submitted")
        self.assertEqual(calls, ["baseline", "candidate", "candidate"])
        with closing(sqlite3.connect(next(state.glob("*.sqlite")))) as db:
            self.assertEqual(db.execute("SELECT arm,state FROM attempts ORDER BY id").fetchall(),
                             [("baseline", "completed"), ("candidate", "failed"), ("candidate", "completed")])

    def test_rebinding_artifact_cannot_reset_existing_job(self):
        experiment = str(uuid.uuid4())
        client = FakeClient(experiment, self.a, self.b, lose=True)
        state = self.root / "journal"
        with self.assertRaises(OSError):
            run_verified_pair(client, experiment, self.a, self.b, state, trusted_local=True)
        artifact(self.root, "candidate", SOURCE + "\n# new version\n")
        with self.assertRaisesRegex(ValueError, "identity changed"):
            run_verified_pair(client, experiment, self.a, self.b, state, trusted_local=True)

    def test_concurrent_runner_is_refused_and_lock_releases(self):
        path = self.root / "run.lock"
        with exclusive(path):
            with self.assertRaises(OSError):
                with exclusive(path):
                    pass
        with exclusive(path):
            pass
