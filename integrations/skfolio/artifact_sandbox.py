"""Fail-closed local Linux Docker execution. Requires a reviewed, already-local image ID."""
import hashlib
import json
import os
import re
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from sandbox_registry import SandboxRegistry, OWNER_LABEL

REGISTRY_ROOT = Path(__file__).resolve().parent / ".state" / "sandbox-registry"


class SandboxCleanupError(RuntimeError):
    pass


def image_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", value):
        raise ValueError("Use a complete local sha256 image ID; mutable tags and automatic pulls are forbidden")
    return value


def environment():
    # Do not inherit API/provider credentials, DOCKER_HOST, context, TLS or configuration overrides.
    return {k: os.environ[k] for k in ("PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP") if k in os.environ}


def command(*args):
    host = "npipe:////./pipe/docker_engine" if os.name == "nt" else "unix:///var/run/docker.sock"
    return ["docker", "--host", host, *args]


def bounded_process(args, payload=b"", timeout=10, output_limit=128 * 1024):
    process = subprocess.Popen(command(*args), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               env=environment(), shell=False,
                               creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    streams = {"out": bytearray(), "err": bytearray()}
    overflow = threading.Event()

    def drain(pipe, label, limit):
        try:
            while True:
                chunk = pipe.read(4096)
                if not chunk:
                    break
                if len(streams[label]) + len(chunk) > limit:
                    overflow.set()
                    process.kill()
                    break
                streams[label].extend(chunk)
        finally:
            pipe.close()

    def send():
        try:
            process.stdin.write(payload)
            process.stdin.flush()
        except (OSError, ValueError):
            pass
        finally:
            process.stdin.close()

    threads = [threading.Thread(target=drain, args=(process.stdout, "out", output_limit), daemon=True),
               threading.Thread(target=drain, args=(process.stderr, "err", 16384), daemon=True),
               threading.Thread(target=send, daemon=True)]
    for thread in threads:
        thread.start()
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        raise TimeoutError("Docker operation exceeded deadline") from None
    finally:
        if process.poll() is None:
            process.kill()
        process.wait()
        for thread in threads:
            thread.join(timeout=1)
    if any(thread.is_alive() for thread in threads):
        raise RuntimeError("Docker pipes did not close")
    if overflow.is_set():
        raise ValueError("Docker output exceeded limit")
    if process.returncode:
        raise RuntimeError("Docker operation failed; no local-execution fallback is permitted")
    return bytes(streams["out"])


def preflight(image):
    image_id(image)
    info = json.loads(bounded_process(["info", "--format", "{{json .}}"], output_limit=128 * 1024))
    if info.get("OSType") != "linux" or info.get("CgroupVersion") != "2" or not any(
            "name=seccomp" in option and "profile=builtin" in option for option in info.get("SecurityOptions", [])):
        raise RuntimeError("Linux Docker with cgroup v2 and builtin seccomp is required")
    if not info.get("MemoryLimit") or not info.get("PidsLimit") or not info.get("SwapLimit"):
        raise RuntimeError("Docker memory, swap and PID limit support is required")
    metadata = json.loads(bounded_process(["image", "inspect", image, "--format", "{{json .}}"], output_limit=128 * 1024))
    if metadata.get("Id") != image or metadata.get("Os") != "linux":
        raise RuntimeError("Local image identity or platform mismatch")
    config = metadata.get("Config", {})
    if config.get("Volumes"):
        raise RuntimeError("Images declaring writable volumes are not permitted")
    allowed = {"PATH", "LANG", "LC_ALL", "TZ", "PYTHON_VERSION", "PYTHON_SHA256", "PYTHON_PIP_VERSION", "PYTHON_SETUPTOOLS_VERSION", "GPG_KEY"}
    if any(entry.split("=", 1)[0] not in allowed for entry in config.get("Env", []) or []):
        raise RuntimeError("Image environment contains unreviewed variables")
    return {"imageId": image, "platform": "linux", "remoteAttestation": False}


def create_args(image, name, host_source, owner=None):
    image_id(image)
    return ["create", "--pull=never", "--name", name, "--label", "trading-organisation.paired-sandbox=true",
            "--label", OWNER_LABEL + "=" + (owner or "unregistered"),
            "--network=none", "--cgroupns=private", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges=true",
            "--user=65534:65534", "--pids-limit=16", "--memory=128m", "--memory-swap=128m", "--cpus=1",
            "--ulimit=nofile=64:64", "--ulimit=core=0:0", "--shm-size=1m", "--restart=no", "--no-healthcheck",
            "--log-driver=none", "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777",
            "--workdir=/tmp", "--interactive", "--entrypoint=/usr/local/bin/python3", image, "-I", "-S", "-c", host_source]


def execute_sandbox(artifact, cases, *, image, timeout=10, registry_root=None):
    from artifact_executor import HERE, MAX_SOURCE, bounded_read, digest, encode, validate_answers
    if type(timeout) not in (int, float) or not .1 <= timeout <= 30:
        raise ValueError("Execution timeout must be between 0.1 and 30 seconds")
    preflight(image)
    if hashlib.sha256(artifact.source.encode()).hexdigest() != artifact.manifest["sourceSha256"]:
        raise ValueError("Artifact snapshot fingerprint mismatch")
    payload = encode({"source": artifact.source, "sourceSha256": artifact.manifest["sourceSha256"], "cases": cases}).encode()
    if len(payload) > 192 * 1024:
        raise ValueError("Execution input exceeds limit")
    host = bounded_read(HERE / "artifact_sandbox_guard.py", MAX_SOURCE).decode() + "\n" + bounded_read(HERE / "artifact_child.py", MAX_SOURCE).decode()
    registry = SandboxRegistry(registry_root or REGISTRY_ROOT, bounded_process)
    registry.recover()
    name, owner = registry.reserve(image, timeout)
    started = time.monotonic()
    # Use a private generated name for cleanup even when the create response is lost.
    try:
        container = bounded_process(create_args(image, name, host, owner), output_limit=4096).decode().strip()
        if not re.fullmatch(r"[a-f0-9]{64}", container):
            raise RuntimeError("Invalid container creation receipt")
        registry.confirm(name, container)
        raw = bounded_process(["start", "--attach", "--interactive", container], payload, timeout)
        state = json.loads(bounded_process(["inspect", container, "--format", "{{json .State}}"], output_limit=8192))
        if state.get("Running") or state.get("OOMKilled") or state.get("ExitCode") != 0:
            raise RuntimeError("Container did not finish successfully")
    finally:
        # Never fall back to killing only the CLI: remove the container and its contained processes.
        # If Docker is unavailable, surface cleanup uncertainty rather than claiming successful containment.
        try:
            registry.cleanup(name)
        except Exception as error:
            raise SandboxCleanupError("Sandbox cleanup unconfirmed; inspect the local Docker daemon before retrying") from error
    result = json.loads(raw)
    if (set(result) != {"sourceSha256", "pythonVersion", "results"}
            or result["sourceSha256"] != artifact.manifest["sourceSha256"]
            or not isinstance(result["pythonVersion"], str) or len(result["pythonVersion"]) > 300
            or not isinstance(result["results"], list) or len(result["results"]) != len(cases)):
        raise ValueError("Sandbox receipt does not match inputs")
    for case, answer in zip(cases, result["results"]):
        if set(answer) != {"caseId", "answers"} or answer["caseId"] != case["id"]:
            raise ValueError("Sandbox case identity mismatch")
        validate_answers(answer["answers"])
    return {**result, "imageId": image, "inputHash": digest(cases), "outputHash": digest(result["results"]),
            "elapsedMs": round((time.monotonic() - started) * 1000), "isolation": "docker-linux-container", "remoteAttestation": False}
