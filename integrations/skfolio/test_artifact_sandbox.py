"""Docker protocol contract tests; these do not substitute for live containment checks."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid
from types import SimpleNamespace

from artifact_executor import load_artifact, run_verified_pair
from artifact_sandbox import create_args, environment, execute_sandbox, preflight
from skills import solve
from test_artifact_executor import artifact, cases, FakeClient

IMAGE = "sha256:" + "a" * 64
INFO = {"OSType": "linux", "CgroupVersion": "2", "SecurityOptions": ["name=seccomp,profile=builtin"],
        "MemoryLimit": True, "PidsLimit": True, "SwapLimit": True}
METADATA = {"Id": IMAGE, "Os": "linux", "Config": {"Env": ["PATH=/usr/local/bin:/usr/bin"], "Volumes": None}}


class SandboxTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.a = artifact(self.root, "baseline")
        self.b = artifact(self.root, "candidate")
        self.snapshot = load_artifact(self.a)
        self.questions = cases()
        self.calls = []
        self.container_name = None
        self.container_owner = None
        self.registry_patch = patch("artifact_sandbox.REGISTRY_ROOT", self.root / "registry")
        self.registry_patch.start()

    def tearDown(self):
        self.registry_patch.stop()
        self.temp.cleanup()

    def docker(self, args, payload=b"", timeout=10, output_limit=0):
        self.calls.append(args)
        if args[0] == "info":
            return json.dumps(INFO).encode()
        if args[:2] == ["image", "inspect"]:
            return json.dumps(METADATA).encode()
        if args[0] == "create":
            self.container_name = args[args.index("--name") + 1]
            self.container_owner = next(a.split("=", 1)[1] for a in args if a.startswith("trading-organisation.sandbox-owner="))
            return ("b" * 64).encode()
        if args[:2] == ["container", "ls"]:
            return ("b" * 64).encode() if self.container_name else b""
        if args[0] == "start":
            request = json.loads(payload)
            return json.dumps({"sourceSha256": request["sourceSha256"], "pythonVersion": "fixture-container-python",
                               "results": [{"caseId": c["id"], "answers": solve(c["challenge"])} for c in request["cases"]]}).encode()
        if args[0] == "inspect":
            if args[-1] == "{{json .State}}":
                return json.dumps({"Running": False, "OOMKilled": False, "ExitCode": 0}).encode()
            return json.dumps({"Id": "b" * 64, "Name": "/" + self.container_name, "Image": IMAGE,
                               "Config": {"Labels": {"trading-organisation.sandbox-owner": self.container_owner,
                                                      "trading-organisation.paired-sandbox": "true"}}}).encode()
        if args[:2] == ["rm", "--force"]:
            self.container_name = None
            return b"removed"
        raise AssertionError("Unexpected Docker operation")

    def test_mutable_images_rejected_without_contacting_daemon(self):
        with patch("artifact_sandbox.bounded_process") as run:
            for image in ("python:latest", "python:3.12", "sha256:abc", "-v /:/host"):
                with self.assertRaises(ValueError):
                    preflight(image)
            run.assert_not_called()

    def test_in_container_guard_checks_effective_limits_before_candidate_code(self):
        source = Path(__file__).with_name("artifact_sandbox_guard.py").read_text()
        valid = {"/proc/self/status": "CapEff:\t00000000\nNoNewPrivs:\t1\nSeccomp:\t2\n",
                 "/proc/mounts": "overlay / overlay ro 0 0\ntmpfs /tmp tmpfs rw,noexec,nosuid,nodev 0 0\n",
                 "/sys/fs/cgroup/memory.max": "134217728", "/sys/fs/cgroup/memory.swap.max": "0",
                 "/sys/fs/cgroup/pids.max": "16", "/sys/fs/cgroup/cpu.max": "100000 100000"}

        def check(changes=None, uid=65534, networks=("lo",), size=16 * 1024 * 1024):
            files = {**valid, **(changes or {})}

            class FakePath:
                def __init__(self, path):
                    self.path = path

                def __truediv__(self, other):
                    return FakePath(self.path + "/" + other)

                def read_text(self):
                    return files[self.path]

                def iterdir(self):
                    return [SimpleNamespace(name=name) for name in networks]

            marker = []
            with patch("pathlib.Path", FakePath), patch("os.getuid", return_value=uid, create=True), patch("os.getgid", return_value=65534, create=True), patch("os.statvfs", return_value=SimpleNamespace(f_frsize=1, f_blocks=size), create=True):
                try:
                    exec(compile(source + "\nmarker.append(True)", "guard-fixture", "exec"), {"marker": marker})
                except (RuntimeError, ValueError):
                    self.assertEqual(marker, [])
                    return False
            return marker == [True]

        self.assertTrue(check())
        for change in ({"/sys/fs/cgroup/memory.max": "max"}, {"/sys/fs/cgroup/memory.swap.max": "1"},
                       {"/sys/fs/cgroup/pids.max": "17"}, {"/sys/fs/cgroup/cpu.max": "200000 100000"},
                       {"/proc/self/status": "CapEff:\t1\nNoNewPrivs:\t1\nSeccomp:\t2\n"},
                       {"/proc/mounts": valid["/proc/mounts"].replace("overlay ro", "overlay rw")}):
            self.assertFalse(check(change))
        self.assertFalse(check(uid=0))
        self.assertFalse(check(networks=("lo", "eth0")))
        self.assertFalse(check(size=32 * 1024 * 1024))

    def test_required_restrictions_and_no_host_mounts_or_inherited_credentials(self):
        args = create_args(IMAGE, "paired-fixture", "print('host')")
        for flag in ("--pull=never", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges=true",
                     "--user=65534:65534", "--pids-limit=16", "--memory=128m", "--memory-swap=128m", "--cpus=1",
                     "--no-healthcheck", "--log-driver=none"):
            self.assertIn(flag, args)
        self.assertFalse(any(arg.startswith(("--volume", "--mount", "--publish", "--privileged")) for arg in args))
        with patch.dict("os.environ", {"API_TOKEN": "secret", "PRINCIPALS_JSON": "secret", "DOCKER_HOST": "tcp://untrusted:2375"}):
            env = environment()
        self.assertFalse(any(k in env for k in ("API_TOKEN", "PRINCIPALS_JSON", "DOCKER_HOST")))

    def test_unavailable_daemon_blocks_work_and_never_falls_back(self):
        experiment = str(uuid.uuid4())
        client = FakeClient(experiment, self.a, self.b)
        with patch("artifact_sandbox.bounded_process", side_effect=RuntimeError("unavailable")), patch("artifact_executor.execute_artifact") as local:
            with self.assertRaises(RuntimeError):
                run_verified_pair(client, experiment, self.a, self.b, self.root / "state", sandbox_image=IMAGE)
            local.assert_not_called()
        self.assertEqual(client.calls, [])

    def test_unsupported_engines_image_volumes_and_image_secrets_are_refused(self):
        for info in ({**INFO, "OSType": "windows"}, {**INFO, "CgroupVersion": "1"}, {**INFO, "SecurityOptions": []}, {**INFO, "MemoryLimit": False}, {**INFO, "PidsLimit": False}, {**INFO, "SwapLimit": False}):
            with patch("artifact_sandbox.bounded_process", return_value=json.dumps(info).encode()):
                with self.assertRaises(RuntimeError):
                    preflight(IMAGE)
        for metadata in ({**METADATA, "Id": "sha256:" + "b" * 64},
                         {**METADATA, "Config": {"Volumes": {"/data": {}}}},
                         {**METADATA, "Config": {"Env": ["API_TOKEN=secret"]}}):
            with patch("artifact_sandbox.bounded_process", side_effect=[json.dumps(INFO).encode(), json.dumps(metadata).encode()]):
                with self.assertRaises(RuntimeError):
                    preflight(IMAGE)

    def test_success_validates_receipt_and_removes_exact_generated_container(self):
        with patch("artifact_sandbox.bounded_process", side_effect=self.docker):
            result = execute_sandbox(self.snapshot, self.questions, image=IMAGE)
        self.assertEqual(result["imageId"], IMAGE)
        self.assertFalse(result["remoteAttestation"])
        created = next(c for c in self.calls if c[0] == "create")
        name = created[created.index("--name") + 1]
        self.assertRegex(name, r"^paired-sandbox-[a-f0-9]{32}$")
        self.assertEqual(self.calls[-1], ["rm", "--force", "b" * 64])

    def test_timeout_removes_container_and_cleanup_failure_is_not_hidden(self):
        def timeout(args, *rest, **options):
            if args[0] == "start":
                raise TimeoutError("fixture timeout")
            return self.docker(args, *rest, **options)
        with patch("artifact_sandbox.bounded_process", side_effect=timeout):
            with self.assertRaises(TimeoutError):
                execute_sandbox(self.snapshot, self.questions, image=IMAGE)
        self.assertEqual(self.calls[-1][:2], ["rm", "--force"])

        def broken_cleanup(args, *rest, **options):
            if args[0] == "rm":
                raise RuntimeError("daemon unavailable")
            return timeout(args, *rest, **options)
        with patch("artifact_sandbox.bounded_process", side_effect=broken_cleanup):
            with self.assertRaisesRegex(RuntimeError, "cleanup unconfirmed"):
                execute_sandbox(self.snapshot, self.questions, image=IMAGE)

    def test_oom_or_lost_create_response_still_attempts_cleanup(self):
        def oom(args, *rest, **options):
            if args[0] == "inspect" and args[-1] == "{{json .State}}":
                return json.dumps({"Running": False, "OOMKilled": True, "ExitCode": 137}).encode()
            return self.docker(args, *rest, **options)
        with patch("artifact_sandbox.bounded_process", side_effect=oom):
            with self.assertRaisesRegex(RuntimeError, "finish successfully"):
                execute_sandbox(self.snapshot, self.questions, image=IMAGE)
        self.assertEqual(self.calls[-1][:2], ["rm", "--force"])

        def lost_create(args, *rest, **options):
            if args[0] == "create":
                self.docker(args, *rest, **options)
                raise TimeoutError("create response lost")
            return self.docker(args, *rest, **options)
        with patch("artifact_sandbox.bounded_process", side_effect=lost_create):
            with self.assertRaises(TimeoutError):
                execute_sandbox(self.snapshot, self.questions, image=IMAGE)
        self.assertEqual(self.calls[-1][:2], ["rm", "--force"])

    def test_durable_submission_retry_needs_no_new_container_or_daemon(self):
        experiment = str(uuid.uuid4())
        client = FakeClient(experiment, self.a, self.b, lose=True)
        state = self.root / "state"
        with patch("artifact_sandbox.bounded_process", side_effect=self.docker), patch("artifact_executor.execute_artifact") as local:
            with self.assertRaises(OSError):
                run_verified_pair(client, experiment, self.a, self.b, state, sandbox_image=IMAGE)
            local.assert_not_called()
        self.assertEqual(len([c for c in self.calls if c[0] == "create"]), 2)
        with patch("artifact_sandbox.bounded_process", side_effect=AssertionError("no new Docker work")):
            result = run_verified_pair(client, experiment, self.a, self.b, state, sandbox_image=IMAGE)
        self.assertEqual(result["status"], "submitted")
        with self.assertRaises(ValueError):
            run_verified_pair(client, experiment, self.a, self.b, state, sandbox_image=IMAGE, trusted_local=True)
