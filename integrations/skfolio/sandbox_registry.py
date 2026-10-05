"""Local ownership/recovery journal. Never removes a container based on its name alone."""
from contextlib import closing
import json
from pathlib import Path
import re
import sqlite3
import time
import uuid

OWNER_LABEL = "trading-organisation.sandbox-owner"


class SandboxRegistry:
    def __init__(self, root, transport):
        self.root, self.transport = Path(root), transport
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = self.root / "containers.sqlite"
        with closing(self.connect()) as db:
            db.executescript("""CREATE TABLE IF NOT EXISTS runs(
                name TEXT PRIMARY KEY, owner TEXT NOT NULL, image TEXT NOT NULL,
                deadline REAL NOT NULL, container_id TEXT, state TEXT NOT NULL, created_at REAL NOT NULL);
              CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
                recorded_at REAL NOT NULL);""")

    def connect(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA synchronous=FULL")
        return db

    def event(self, db, name, kind):
        db.execute("INSERT INTO events(name,kind,recorded_at) VALUES(?,?,?)", (name, kind, time.time()))

    def reserve(self, image, timeout):
        name, owner = "paired-sandbox-" + uuid.uuid4().hex, uuid.uuid4().hex
        with closing(self.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT count(*) FROM runs WHERE state='cleanup-required'").fetchone()[0]:
                raise RuntimeError("Unresolved sandbox cleanup blocks new execution")
            if db.execute("SELECT count(*) FROM runs WHERE state='active'").fetchone()[0] >= 3:
                raise RuntimeError("Local sandbox concurrency limit reached")
            if db.execute("SELECT count(*) FROM runs").fetchone()[0] >= 1000:
                raise RuntimeError("Local sandbox history capacity reached")
            db.execute("INSERT INTO runs VALUES(?,?,?,?,NULL,'active',?)", (name, owner, image, time.time() + timeout + 60, time.time()))
            self.event(db, name, "reserved-before-create")
        return name, owner

    def confirm(self, name, container_id):
        if not re.fullmatch(r"[a-f0-9]{64}", container_id):
            raise ValueError("Invalid container ID")
        with closing(self.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM runs WHERE name=?", (name,)).fetchone()
            if not row or row["state"] != "active" or (row["container_id"] and row["container_id"] != container_id):
                raise RuntimeError("Container ownership changed")
            db.execute("UPDATE runs SET container_id=? WHERE name=?", (container_id, name))
            self.event(db, name, "creation-confirmed")

    def cleanup(self, name, *, acknowledge_absent=False):
        with closing(self.connect()) as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM runs WHERE name=?", (name,)).fetchone()
            if not row:
                raise ValueError("Unknown sandbox ownership record")
            if row["state"] == "removed":
                db.commit()
                return
            if acknowledge_absent and time.time() < row["deadline"]:
                raise RuntimeError("Operator absence acknowledgement requires an expired lease")
            try:
                raw = self.transport(["container", "ls", "--all", "--no-trunc", "--filter", "name=^/" + name + "$", "--format", "{{.ID}}"], output_limit=4096)
                ids = raw.decode().split()
                if not ids:
                    if not row["container_id"] and not (acknowledge_absent and time.time() >= row["deadline"]):
                        raise RuntimeError("Creation outcome unknown; absent container needs expired-lease operator acknowledgement")
                    kind = "absence-confirmed" if row["container_id"] else "operator-acknowledged-absence"
                else:
                    if len(ids) != 1 or not re.fullmatch(r"[a-f0-9]{64}", ids[0]):
                        raise RuntimeError("Ambiguous container identity")
                    metadata = json.loads(self.transport(["inspect", ids[0], "--format", "{{json .}}"], output_limit=128 * 1024))
                    labels = metadata.get("Config", {}).get("Labels", {}) or {}
                    if (metadata.get("Id") != ids[0] or metadata.get("Name") != "/" + name
                            or metadata.get("Image") != row["image"] or labels.get(OWNER_LABEL) != row["owner"]
                            or labels.get("trading-organisation.paired-sandbox") != "true"
                            or (row["container_id"] and row["container_id"] != ids[0])):
                        raise RuntimeError("Container ownership mismatch; removal refused")
                    self.transport(["rm", "--force", ids[0]], output_limit=4096)
                    kind = "owned-container-removed"
                db.execute("UPDATE runs SET state='removed' WHERE name=?", (name,))
                self.event(db, name, kind)
                db.commit()
            except BaseException:
                db.execute("UPDATE runs SET state='cleanup-required' WHERE name=?", (name,))
                self.event(db, name, "cleanup-unconfirmed")
                db.commit()
                raise

    def recover(self):
        with closing(self.connect()) as db:
            names = [r[0] for r in db.execute("SELECT name FROM runs WHERE state='cleanup-required' OR (state='active' AND deadline<=?) ORDER BY created_at LIMIT 10", (time.time(),))]
        for name in names:
            self.cleanup(name)
        return {"recovered": len(names)}

    def status(self):
        with closing(self.connect()) as db:
            return [dict(r) for r in db.execute("SELECT name,image,deadline,container_id,state FROM runs WHERE state<>'removed' ORDER BY created_at")]
