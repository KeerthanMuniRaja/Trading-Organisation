"""Durable best-effort reporting of fixed operational codes; no raw errors or secrets."""
import hashlib
import json


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def publish_execution(db, client, mode, image=None):
    db.execute("""CREATE TABLE IF NOT EXISTS execution_outbox(
      sequence INTEGER PRIMARY KEY, event_key TEXT NOT NULL UNIQUE, event TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0)""")
    work_row = db.execute("SELECT work FROM job WHERE id=1").fetchone()
    if not work_row or not work_row[0]:
        return {"pending": 0, "reported": False}
    work = json.loads(work_row[0])

    def enqueue(event_key, event):
        if db.execute("SELECT 1 FROM execution_outbox WHERE event_key=?", (event_key,)).fetchone():
            return
        sequence = db.execute("SELECT count(*) FROM execution_outbox").fetchone()[0] + 1
        if sequence > 16:
            raise ValueError("Execution reporting capacity reached")
        event = {"sequence": sequence, **event}
        db.execute("INSERT INTO execution_outbox(sequence,event_key,event) VALUES(?,?,?)", (sequence, event_key, encode(event)))

    counters = {"baseline": 0, "candidate": 0}
    codes = {"TimeoutError": "TIMEOUT", "ValueError": "VALIDATION_FAILED", "SandboxCleanupError": "CLEANUP_UNCONFIRMED"}
    for attempt_id, arm, state, error in db.execute("SELECT id,arm,state,error FROM attempts ORDER BY id").fetchall():
        counters[arm] += 1
        base = {"stage": arm, "attempt": counters[arm]}
        enqueue(f"attempt-{attempt_id}-started", {**base, "state": "started", "code": "NONE"})
        if state in ("completed", "failed", "interrupted"):
            outcome = {"completed": "succeeded", "failed": "failed", "interrupted": "interrupted"}[state]
            code = "NONE" if state == "completed" else "INTERRUPTED" if state == "interrupted" else codes.get(error, "EXECUTION_FAILED")
            enqueue(f"attempt-{attempt_id}-finished", {**base, "state": outcome, "code": code})
    for (kind,) in db.execute("SELECT kind FROM events WHERE kind IN ('submission-unconfirmed','submission-confirmed') ORDER BY id").fetchall():
        state = "confirmed" if kind == "submission-confirmed" else "unconfirmed"
        enqueue(kind, {"stage": "submission", "attempt": 1, "state": state, "code": "NONE" if state == "confirmed" else "SUBMISSION_UNCONFIRMED"})
    db.commit()
    pending = [json.loads(row[0]) for row in db.execute("SELECT event FROM execution_outbox WHERE delivered=0 ORDER BY sequence")]
    if not pending:
        return {"pending": 0, "reported": True}
    body = {k: work[k] for k in ("experimentId", "planHash", "baselineHash", "candidateHash")}
    body.update({"mode": mode, "events": pending})
    if image:
        body["imageId"] = image
    key = "execution-report-" + hashlib.sha256(encode(body).encode()).hexdigest()
    try:
        response = client.post("/v1/skills/experiments/execution-reports", body, key)
        if response.get("experimentId") != work["experimentId"] or response.get("lastSequence", 0) < pending[-1]["sequence"]:
            raise ValueError("Execution report acknowledgement mismatch")
    except Exception:
        # The already-committed outbox remains available for a later retry.
        return {"pending": len(pending), "reported": False}
    db.execute("UPDATE execution_outbox SET delivered=1 WHERE sequence<=?", (pending[-1]["sequence"],))
    db.commit()
    return {"pending": 0, "reported": True}
