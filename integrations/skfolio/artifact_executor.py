"""Hash-bound trusted local paired execution with durable, bounded retries.

Not suitable for hostile/generated code. No remote attestation or release authority.
"""
from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import uuid

HERE = Path(__file__).resolve().parent
MAX_SOURCE = 64 * 1024
MAX_OUTPUT = 128 * 1024


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value):
    return hashlib.sha256(encode(value).encode()).hexdigest()


def bounded_read(path, maximum):
    with Path(path).open("rb") as handle:
        value = handle.read(maximum + 1)
    if len(value) > maximum:
        raise ValueError("Artifact or journal exceeds size limit")
    return value


@dataclass(frozen=True)
class Artifact:
    manifest: dict
    source: str


def load_artifact(descriptor):
    path = Path(descriptor).resolve(strict=True)
    info = json.loads(bounded_read(path, 8192))
    if set(info) != {"producer", "sourceFile"}:
        raise ValueError("Unexpected artifact descriptor fields")
    name = info["sourceFile"]
    if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_-][A-Za-z0-9_.-]*\.py", name):
        raise ValueError("Source must be a Python basename beside its descriptor")
    source_path = (path.parent / name).resolve(strict=True)
    if source_path.parent != path.parent:
        raise ValueError("Source resolves outside descriptor directory")
    manifest = info["producer"]
    if (not isinstance(manifest, dict) or set(manifest) != {"name", "version", "kind", "sourceSha256"}
            or manifest["kind"] != "deterministic"
            or any(not isinstance(manifest[k], str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", manifest[k]) for k in ("name", "version"))
            or not isinstance(manifest["sourceSha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", manifest["sourceSha256"])):
        raise ValueError("Only strict deterministic producer manifests are supported")
    raw = bounded_read(source_path, MAX_SOURCE).replace(b"\r\n", b"\n")
    if hashlib.sha256(raw).hexdigest() != manifest["sourceSha256"]:
        raise ValueError("Source fingerprint differs from reviewed descriptor")
    return Artifact(manifest, raw.decode("utf-8"))


def validate_answers(answer):
    if not isinstance(answer, dict) or set(answer) != {"netProfitPaise", "maxDrawdownBps", "eligibleRecordIds", "action"}:
        raise ValueError("Invalid solver answer shape")
    n, d, records = answer["netProfitPaise"], answer["maxDrawdownBps"], answer["eligibleRecordIds"]
    if (type(n) is not int or not -1000000 <= n <= 1000000 or type(d) not in (int, float)
            or not math.isfinite(d) or not 0 <= d <= 10000 or answer["action"] not in ("research", "wait")
            or not isinstance(records, list) or len(records) > 6
            or any(not isinstance(v, str) or not re.fullmatch(r"record-[0-9]", v) for v in records)
            or len(set(records)) != len(records)):
        raise ValueError("Invalid solver answer values")


def execute_artifact(artifact, cases, *, trusted_local=False, timeout=10):
    if trusted_local is not True:
        raise ValueError("Explicit trusted-local-code acknowledgement required; this is not a sandbox")
    if type(timeout) not in (int, float) or not 0.1 <= timeout <= 30:
        raise ValueError("Execution timeout must be between 0.1 and 30 seconds")
    if hashlib.sha256(artifact.source.encode()).hexdigest() != artifact.manifest["sourceSha256"]:
        raise ValueError("Artifact snapshot fingerprint mismatch")
    data = encode({"source": artifact.source, "sourceSha256": artifact.manifest["sourceSha256"], "cases": cases}).encode()
    if len(data) > 192 * 1024:
        raise ValueError("Execution input exceeds limit")
    # Preserve only Windows runtime essentials; never forward PATH, API tokens or provider credentials.
    env = {k: os.environ[k] for k in ("SystemRoot", "SYSTEMROOT", "WINDIR") if k in os.environ}
    started = time.monotonic()
    chunks = {"out": bytearray(), "err": bytearray()}
    overflow = threading.Event()
    with tempfile.TemporaryDirectory(prefix="paired-local-") as directory:
        env.update({"TEMP": directory, "TMP": directory})
        process = subprocess.Popen([sys.executable, "-I", "-S", str(HERE / "artifact_child.py")], cwd=directory,
                                   env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)

        def drain(stream, label, limit):
            try:
                while True:
                    chunk = stream.read(4096)
                    if not chunk:
                        break
                    if len(chunks[label]) + len(chunk) > limit:
                        overflow.set()
                        process.kill()
                        break
                    chunks[label].extend(chunk)
            finally:
                stream.close()

        def send():
            try:
                process.stdin.write(data)
                process.stdin.flush()
            except (OSError, ValueError):
                pass
            finally:
                process.stdin.close()

        threads = [threading.Thread(target=drain, args=(process.stdout, "out", MAX_OUTPUT), daemon=True),
                   threading.Thread(target=drain, args=(process.stderr, "err", 16384), daemon=True),
                   threading.Thread(target=send, daemon=True)]
        for thread in threads:
            thread.start()
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
            raise TimeoutError("Trusted local solver exceeded deadline") from None
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            for thread in threads:
                thread.join(timeout=1)
        if any(thread.is_alive() for thread in threads):
            raise RuntimeError("Solver pipe did not close; descendant processes are unsupported")
        if overflow.is_set():
            raise ValueError("Solver output exceeded limit")
        if process.returncode != 0:
            raise RuntimeError("Trusted local solver exited unsuccessfully")
    result = json.loads(chunks["out"])
    if (set(result) != {"sourceSha256", "pythonVersion", "results"}
            or result["sourceSha256"] != artifact.manifest["sourceSha256"] or result["pythonVersion"] != sys.version
            or not isinstance(result["results"], list) or len(result["results"]) != len(cases)):
        raise ValueError("Solver receipt does not match verified inputs")
    for case, answer in zip(cases, result["results"]):
        if set(answer) != {"caseId", "answers"} or answer["caseId"] != case["id"]:
            raise ValueError("Solver case identity mismatch")
        validate_answers(answer["answers"])
    return {**result, "elapsedMs": round((time.monotonic() - started) * 1000),
            "inputHash": digest(cases), "outputHash": digest(result["results"]),
            "isolation": "trusted-local-process-only", "remoteAttestation": False}


@contextmanager
def exclusive(path):
    with path.open("a+b") as handle:
        handle.seek(0)
        if not handle.read(1):
            handle.write(b"0")
            handle.flush()
        handle.seek(0)
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)


def run_verified_pair(client, experiment_id, baseline_path, candidate_path, state, *, trusted_local=False, timeout=10, sandbox_image=None, report_execution=False):
    if sandbox_image is not None:
        from artifact_sandbox import image_id
        image_id(sandbox_image)
        if trusted_local:
            raise ValueError("Choose sandbox mode or trusted local mode, never both")
    elif trusted_local is not True:
        raise ValueError("Choose an explicit sandbox image or trusted-local-code acknowledgement")
    experiment_id = str(uuid.UUID(experiment_id))
    baseline, candidate = load_artifact(baseline_path), load_artifact(candidate_path)
    identity = {"experimentId": experiment_id, "baselineHash": digest(baseline.manifest), "candidateHash": digest(candidate.manifest)}
    if identity["baselineHash"] == identity["candidateHash"]:
        raise ValueError("Different producer declarations required")
    binding = {**identity, "origin": client.base, "credentialHash": hashlib.sha256(client.token.encode()).hexdigest(),
               "pythonVersion": sys.version, "hostHash": hashlib.sha256(bounded_read(HERE / "artifact_child.py", MAX_SOURCE)).hexdigest(),
               "executorHash": hashlib.sha256(bounded_read(__file__, MAX_SOURCE)).hexdigest(), "timeout": timeout,
               "sandboxImage": sandbox_image,
               "sandboxHostHash": hashlib.sha256(bounded_read(HERE / "artifact_sandbox.py", MAX_SOURCE)).hexdigest() if sandbox_image else None,
               "sandboxGuardHash": hashlib.sha256(bounded_read(HERE / "artifact_sandbox_guard.py", MAX_SOURCE)).hexdigest() if sandbox_image else None,
               "sandboxRegistryHash": hashlib.sha256(bounded_read(HERE / "sandbox_registry.py", MAX_SOURCE)).hexdigest() if sandbox_image else None}
    directory = Path(state)
    directory.mkdir(parents=True, exist_ok=True)
    # One journal per backend credential and experiment. Changing code cannot evade its attempt budget.
    name = digest({"origin": client.base, "credentialHash": binding["credentialHash"], "experimentId": experiment_id})
    with exclusive(directory / (name + ".lock")):
        db = sqlite3.connect(directory / (name + ".sqlite"))
        reporting = {"pending": 0, "reported": False}

        def publish():
            if report_execution:
                from execution_reporting import publish_execution
                reporting.update(publish_execution(db, client, "docker-linux-container" if sandbox_image else "trusted-local-process-only", sandbox_image))

        try:
            db.execute("PRAGMA synchronous=FULL")
            db.executescript("""CREATE TABLE IF NOT EXISTS job(id INTEGER PRIMARY KEY CHECK(id=1), binding TEXT NOT NULL, work TEXT, payload TEXT, response TEXT);
              CREATE TABLE IF NOT EXISTS attempts(id INTEGER PRIMARY KEY, arm TEXT NOT NULL, state TEXT NOT NULL, receipt TEXT, error TEXT);
              CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);""")
            row = db.execute("SELECT binding FROM job WHERE id=1").fetchone()
            if row and row[0] != encode(binding):
                raise ValueError("Saved execution identity changed; restore the original artifacts and runtime")
            if not row:
                db.execute("INSERT INTO job(id,binding) VALUES(1,?)", (encode(binding),))
            db.execute("UPDATE attempts SET state='interrupted',error='ProcessInterrupted' WHERE state='running'")
            db.commit()
            saved = db.execute("SELECT work,payload,response FROM job WHERE id=1").fetchone()
            publish()
            if saved[2]:
                return {"status": "submitted", "historicalReceipt": True, "response": json.loads(saved[2]), "journal": name, "executionReporting": reporting}
            if not saved[1]:
                if sandbox_image:
                    from artifact_sandbox import preflight
                    preflight(sandbox_image)
                work = client.post("/v1/skills/experiments/work", identity, "artifact-work-" + experiment_id)
                if (any(work.get(k) != v for k, v in identity.items()) or work.get("rubric") != "research-basics-v1"
                        or not re.fullmatch(r"[a-f0-9]{64}", work.get("planHash", ""))):
                    raise ValueError("Work does not match the declared pair")
                cases = work["cases"]
                if not 8 <= len(cases) <= 32 or len({c["id"] for c in cases}) != len(cases):
                    raise ValueError("Invalid paired case set")
                if saved[0] and saved[0] != encode(work):
                    raise ValueError("Previously bound plan changed")
                db.execute("UPDATE job SET work=? WHERE id=1", (encode(work),))
                db.commit()
                receipts = {}
                for arm, artifact in (("baseline", baseline), ("candidate", candidate)):
                    prior = db.execute("SELECT receipt FROM attempts WHERE arm=? AND state='completed'", (arm,)).fetchone()
                    if prior:
                        receipts[arm] = json.loads(prior[0])
                        continue
                    if db.execute("SELECT count(*) FROM attempts WHERE arm=?", (arm,)).fetchone()[0] >= 2:
                        raise ValueError("Local artifact retry budget exhausted")
                    # Check current server support immediately before each new arm; it may change during execution.
                    current = client.post("/v1/skills/experiments/work", identity, "artifact-work-" + experiment_id)
                    if encode(current) != encode(work):
                        raise ValueError("Paired work changed before execution")
                    attempt = db.execute("INSERT INTO attempts(arm,state) VALUES(?,'running')", (arm,)).lastrowid
                    db.commit()
                    publish()
                    try:
                        if sandbox_image:
                            from artifact_sandbox import execute_sandbox
                            receipt = execute_sandbox(artifact, cases, image=sandbox_image, timeout=timeout)
                        else:
                            receipt = execute_artifact(artifact, cases, trusted_local=True, timeout=timeout)
                    except BaseException as error:
                        db.execute("UPDATE attempts SET state='failed',error=? WHERE id=?", (type(error).__name__, attempt))
                        db.commit()
                        publish()
                        raise
                    db.execute("UPDATE attempts SET state='completed',receipt=? WHERE id=?", (encode(receipt), attempt))
                    db.commit()
                    publish()
                    receipts[arm] = receipt
                body = {**identity, "planHash": work["planHash"], "results": [
                    {"caseId": c["id"], "baseline": receipts["baseline"]["results"][i]["answers"],
                     "candidate": receipts["candidate"]["results"][i]["answers"]} for i, c in enumerate(cases)]}
                # Commit the exact payload before contacting the backend; lost responses never cause re-execution.
                db.execute("UPDATE job SET payload=? WHERE id=1", (encode(body),))
                db.commit()
            else:
                body = json.loads(saved[1])
            db.execute("INSERT INTO events(kind) VALUES('submission-request')")
            db.commit()
            try:
                response = client.post("/v1/skills/experiments/submissions", body, "artifact-submit-" + experiment_id)
                if response.get("experimentId") != experiment_id or response.get("status") != "submitted":
                    raise ValueError("Submission acknowledgement mismatch")
            except BaseException:
                db.execute("INSERT INTO events(kind) VALUES('submission-unconfirmed')")
                db.commit()
                publish()
                raise
            db.execute("UPDATE job SET response=? WHERE id=1", (encode(response),))
            db.execute("INSERT INTO events(kind) VALUES('submission-confirmed')")
            db.commit()
            publish()
            return {"status": "submitted", "historicalReceipt": False, "response": response, "journal": name, "executionReporting": reporting}
        finally:
            db.close()


def main():
    import argparse
    if sys.argv[1:2] == ["sandbox-recover"]:
        from artifact_sandbox import REGISTRY_ROOT, bounded_process
        from sandbox_registry import SandboxRegistry
        parser = argparse.ArgumentParser(description="Recover only recorded, expired or cleanup-required owned containers")
        parser.add_argument("--state", default=str(REGISTRY_ROOT))
        parser.add_argument("--acknowledge-absent", help="Explicitly resolve an expired uncertain-create record after absence is checked")
        args = parser.parse_args(sys.argv[2:])
        registry = SandboxRegistry(args.state, bounded_process)
        if args.acknowledge_absent:
            registry.cleanup(args.acknowledge_absent, acknowledge_absent=True)
        print(encode({**registry.recover(), "pending": registry.status()}))
        return
    if sys.argv[1:2] == ["sandbox-check"]:
        from artifact_sandbox import preflight
        parser = argparse.ArgumentParser(description="Check a reviewed local sandbox image without executing a solver")
        parser.add_argument("--image", required=True)
        args = parser.parse_args(sys.argv[2:])
        print(encode(preflight(args.image)))
        return
    if sys.argv[1:2] == ["describe"]:
        parser = argparse.ArgumentParser(description="Describe a reviewed standalone Python source; does not execute it")
        parser.add_argument("source")
        parser.add_argument("--name", required=True)
        parser.add_argument("--version", required=True)
        args = parser.parse_args(sys.argv[2:])
        path = Path(args.source)
        if not re.fullmatch(r"[A-Za-z0-9_-][A-Za-z0-9_.-]*\.py", path.name) or any(
                not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", value) for value in (args.name, args.version)):
            raise ValueError("Invalid source filename or producer identity")
        raw = bounded_read(path, MAX_SOURCE).replace(b"\r\n", b"\n")
        raw.decode("utf-8")
        print(encode({"sourceFile": path.name, "producer": {"name": args.name, "version": args.version,
                     "kind": "deterministic", "sourceSha256": hashlib.sha256(raw).hexdigest()}}))
        return
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--experiment", required=True)
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--state", default=str(HERE / ".state" / "paired-artifacts"))
    parser.add_argument("--timeout", type=float, default=10)
    parser.add_argument("--trust-reviewed-local-code", action="store_true")
    parser.add_argument("--sandbox-image", help="Full local sha256 image ID; no pulls or local fallback")
    args = parser.parse_args()
    sys.path.insert(0, str(HERE.parents[1]))
    from services.research.worker import Client
    client = Client(os.environ["API_URL"], os.environ["API_TOKEN"])
    print(encode(run_verified_pair(client, args.experiment, args.baseline, args.candidate, args.state,
                                   trusted_local=args.trust_reviewed_local_code, timeout=args.timeout, sandbox_image=args.sandbox_image, report_execution=True)))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Keep source, arbitrary solver exceptions and credentials out of console logs.
        sys.stderr.write("Artifact execution stopped: " + type(error).__name__ + ". Check local journal and artifact configuration.\n")
        sys.exit(1)
