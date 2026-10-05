"""Ownership and crash recovery contracts, independent of Docker availability."""
from contextlib import closing
import json
from pathlib import Path
import tempfile
import subprocess
import sys
import os
import unittest
from unittest.mock import patch

from sandbox_registry import SandboxRegistry, OWNER_LABEL

IMAGE = "sha256:" + "a" * 64
CONTAINER = "b" * 64


class RegistryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.containers = {}
        self.removed = []
        self.registry = SandboxRegistry(Path(self.temp.name), self.transport)

    def tearDown(self):
        self.temp.cleanup()

    def transport(self, args, **options):
        if args[:2] == ["container", "ls"]:
            name = args[args.index("--filter") + 1].removeprefix("name=^/").removesuffix("$")
            return CONTAINER.encode() if name in self.containers else b""
        if args[0] == "inspect":
            return json.dumps(next(iter(self.containers.values()))).encode()
        if args[:2] == ["rm", "--force"]:
            self.removed.append(args[2])
            self.containers.clear()
            return b"removed"
        raise AssertionError("Unexpected operation")

    def created(self, confirm=True):
        name, owner = self.registry.reserve(IMAGE, 10)
        self.containers[name] = {"Id": CONTAINER, "Name": "/" + name, "Image": IMAGE,
                                 "Config": {"Labels": {OWNER_LABEL: owner, "trading-organisation.paired-sandbox": "true"}}}
        if confirm:
            self.registry.confirm(name, CONTAINER)
        return name

    def expire(self, name):
        with closing(self.registry.connect()) as db, db:
            db.execute("UPDATE runs SET deadline=0 WHERE name=?", (name,))

    def test_ownership_is_persisted_before_create_and_only_expired_runs_recover(self):
        name = self.created()
        restored = SandboxRegistry(Path(self.temp.name), self.transport)
        self.assertEqual(restored.recover(), {"recovered": 0})
        self.assertEqual(self.removed, [])
        self.expire(name)
        self.assertEqual(restored.recover(), {"recovered": 1})
        self.assertEqual(self.removed, [CONTAINER])
        self.assertEqual(restored.status(), [])
        with closing(restored.connect()) as db:
            self.assertEqual([r[0] for r in db.execute("SELECT kind FROM events ORDER BY id")],
                             ["reserved-before-create", "creation-confirmed", "owned-container-removed"])

    def test_lost_create_response_recovers_by_owner_label_without_a_confirmed_id(self):
        name = self.created(confirm=False)
        self.expire(name)
        self.registry.recover()
        self.assertEqual(self.removed, [CONTAINER])

    def test_reservation_survives_abrupt_coordinator_process_exit(self):
        source = """
import json, os, sys
import sandbox_registry as module
module.time.time = lambda: 0.0
registry = module.SandboxRegistry(sys.argv[1], None)
name, owner = registry.reserve(sys.argv[2], 1)
print(json.dumps({'name': name, 'owner': owner}), flush=True)
os._exit(17)
"""
        env = {k: os.environ[k] for k in ("SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP") if k in os.environ}
        result = subprocess.run([sys.executable, "-c", source, self.temp.name, IMAGE],
                                cwd=Path(__file__).resolve().parent, env=env, capture_output=True, timeout=10,
                                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        self.assertEqual(result.returncode, 17)
        saved = json.loads(result.stdout)
        self.containers[saved["name"]] = {"Id": CONTAINER, "Name": "/" + saved["name"], "Image": IMAGE,
                                          "Config": {"Labels": {OWNER_LABEL: saved["owner"], "trading-organisation.paired-sandbox": "true"}}}
        self.assertEqual(self.registry.recover(), {"recovered": 1})
        self.assertEqual(self.removed, [CONTAINER])

    def test_foreign_label_image_or_name_never_gets_deleted_and_blocks_new_execution(self):
        for field in ("owner", "Image", "Name", "Id"):
            with self.subTest(field=field):
                with tempfile.TemporaryDirectory() as directory:
                    registry = SandboxRegistry(directory, self.transport)
                    name, owner = registry.reserve(IMAGE, 10)
                    meta = {"Id": CONTAINER, "Name": "/" + name, "Image": IMAGE,
                            "Config": {"Labels": {OWNER_LABEL: owner, "trading-organisation.paired-sandbox": "true"}}}
                    if field == "owner":
                        meta["Config"]["Labels"][OWNER_LABEL] = "someone-else"
                    else:
                        meta[field] = "different"
                    self.containers = {name: meta}
                    with self.assertRaisesRegex(RuntimeError, "ownership mismatch"):
                        registry.cleanup(name)
                    with self.assertRaisesRegex(RuntimeError, "cleanup blocks"):
                        registry.reserve(IMAGE, 10)
                    self.assertEqual(self.removed, [])

    def test_uncertain_absence_requires_expired_lease_and_explicit_acknowledgement(self):
        name, _ = self.registry.reserve(IMAGE, 10)
        with self.assertRaisesRegex(RuntimeError, "outcome unknown"):
            self.registry.cleanup(name)
        with self.assertRaisesRegex(RuntimeError, "expired lease"):
            self.registry.cleanup(name, acknowledge_absent=True)
        self.expire(name)
        with self.assertRaisesRegex(RuntimeError, "outcome unknown"):
            self.registry.recover()
        self.registry.cleanup(name, acknowledge_absent=True)
        self.assertEqual(self.registry.status(), [])
        self.assertEqual(self.removed, [])

    def test_confirmed_absence_is_safe_and_daemon_failure_remains_unresolved(self):
        name = self.created()
        self.containers.clear()
        self.registry.cleanup(name)
        self.assertEqual(self.registry.status(), [])
        name = self.created()
        with patch.object(self.registry, "transport", side_effect=RuntimeError("daemon offline")):
            with self.assertRaises(RuntimeError):
                self.registry.cleanup(name)
        self.assertEqual(self.registry.status()[0]["state"], "cleanup-required")
        self.registry.recover()
        self.assertEqual(self.removed, [CONTAINER])

    def test_local_capacity_and_unknown_record_protect_other_containers(self):
        for _ in range(3):
            self.registry.reserve(IMAGE, 10)
        with self.assertRaisesRegex(RuntimeError, "concurrency limit"):
            self.registry.reserve(IMAGE, 10)
        with self.assertRaisesRegex(ValueError, "Unknown"):
            self.registry.cleanup("not-our-container")
        self.assertEqual(self.removed, [])
