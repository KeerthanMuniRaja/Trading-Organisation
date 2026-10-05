"""Offline example-data academy. No model API, broker, backend or wallet client."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
from pathlib import Path
import sqlite3
import time

import numpy as np
from skfolio import RiskMeasure
from skfolio.datasets import load_sp500_dataset
from skfolio.model_selection import WalkForward
from skfolio.optimization import EqualWeighted, InverseVolatility, MeanRisk

HERE = Path(__file__).resolve().parent
DEFAULT_STATE = HERE / ".state"
METHODS = ("equal_weight", "inverse_volatility", "minimum_variance")
CONFIG = {"trainBars": 252, "testBars": 63, "priceBars": 2521,
          "costBps": 15, "weightCap": 0.25, "maxAttempts": 2,
          "methods": METHODS, "purpose": "example-data-testing-only"}


def encoded(value):
    return json.dumps(value, sort_keys=True, allow_nan=False, separators=(",", ":"))


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(value):
    return hashlib.sha256(value).hexdigest()


def replace_report(temporary, destination):
    # Windows readers/indexers can briefly hold a destination without delete sharing.
    for attempt in range(6):
        try:
            temporary.replace(destination)
            return
        except PermissionError:
            if attempt == 5:
                raise
            time.sleep(0.05 * 2 ** attempt)


def load_returns():
    # This loader uses the wheel's bundled example; never fetch a live feed.
    prices = load_sp500_dataset().tail(CONFIG["priceBars"])
    if len(prices) != CONFIG["priceBars"] or not prices.index.is_monotonic_increasing or not prices.index.is_unique:
        raise ValueError("Unexpected example dataset chronology")
    if not np.isfinite(prices.to_numpy()).all() or (prices <= 0).any().any():
        raise ValueError("Missing or invalid prices; do not silently fill future data")
    return prices.pct_change(fill_method=None).iloc[1:]


def weights_for(method, training):
    # Only training rows reach fit. No hyperparameter search on evaluation rows.
    factories = {"equal_weight": EqualWeighted, "inverse_volatility": InverseVolatility,
                 "minimum_variance": lambda: MeanRisk(risk_measure=RiskMeasure.VARIANCE,
                     min_weights=0, max_weights=CONFIG["weightCap"], solver="CLARABEL")}
    model = factories[method]().fit(training)
    return validate_weights(model.weights_, training.shape[1])


def validate_weights(weights, assets):
    w = np.asarray(weights, dtype=float)
    if (w.shape != (assets,) or not np.isfinite(w).all() or np.min(w) < -1e-7
            or np.max(w) > CONFIG["weightCap"] + 1e-7 or abs(w.sum() - 1) > 1e-6):
        raise ValueError("Allocation violates the fixed research constraints")
    w = np.maximum(w, 0)
    return w / w.sum()


def score(weights, test_returns, cost_bps):
    """Buy and hold for one window; entry/exit costs, drifting asset weights.

    Each window liquidates to cash. No cost-free daily constant-weight rebalance.
    Returns are dimensionless and never denominated as INR wallet profit.
    """
    if not 1 <= cost_bps <= 1000:
        raise ValueError("Invalid costs")
    r = np.asarray(test_returns, dtype=float)
    if r.ndim != 2 or not len(r) or not np.isfinite(r).all() or (r <= -1).any():
        raise ValueError("Invalid evaluation returns")
    w = validate_weights(weights, r.shape[1])
    cost = cost_bps / 10000
    curve = (np.cumprod(1 + r, axis=0) @ w) * (1 - cost)
    # Include initial capital, entry expense, and final liquidation in drawdown.
    equity = np.r_[1.0, 1 - cost, curve, curve[-1] * (1 - cost)]
    if not np.isfinite(equity).all():
        raise ValueError("Non-finite equity")
    return {"netReturnBps": float((equity[-1] - 1) * 10000),
            "maxDrawdownBps": float(np.max(1 - equity / np.maximum.accumulate(equity)) * 10000)}


@contextmanager
def exclusive_run(path):
    # OS releases the lock after a crash; the file itself may safely remain.
    with path.open("a+b") as handle:
        handle.seek(0)
        if not handle.read(1):
            handle.write(b"0")
            handle.flush()
        handle.seek(0)
        if __import__("os").name == "nt":
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield
        finally:
            handle.seek(0)
            if __import__("os").name == "nt":
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)


def database(path):
    db = sqlite3.connect(path)
    db.execute("PRAGMA journal_mode=WAL")
    db.executescript("""
        CREATE TABLE IF NOT EXISTS attempts (
          id INTEGER PRIMARY KEY, plan TEXT NOT NULL, trial TEXT NOT NULL,
          started TEXT NOT NULL, finished TEXT, state TEXT NOT NULL,
          result TEXT, error TEXT);
        CREATE UNIQUE INDEX IF NOT EXISTS one_success ON attempts(plan,trial) WHERE state='completed';
    """)
    return db


def write_report(db, state, plan, metadata, expected):
    rows = db.execute("SELECT trial,state,result,error FROM attempts WHERE plan=? ORDER BY id", (plan,)).fetchall()
    completed = [{"trial": t, **json.loads(r)} for t, s, r, e in rows if s == "completed"]
    exhausted = sum(1 for trial in set(t for t, s, r, e in rows)
                    if not any(t == trial and s == "completed" for t, s, r, e in rows)
                    and sum(t == trial for t, s, r, e in rows) >= CONFIG["maxAttempts"])
    report = {"planId": plan, "updatedAt": now(), "status": "completed" if len(completed) == expected
              else "needs_attention" if len(completed) + exhausted == expected else "paused",
              "expectedTrials": expected, "completedTrials": len(completed), "attempts": len(rows),
              "failedAttempts": sum(s in {"failed", "interrupted"} for t, s, r, e in rows),
              "promotionAllowed": False, "metadata": metadata, "results": completed,
              "errors": [{"trial": t, "state": s, "error": e} for t, s, r, e in rows if e]}
    summaries = []
    for method in METHODS:
        records = [r for r in completed if r["method"] == method]
        summaries.append({"method": method, "windows": len(records),
            "positiveRewards": sum(r["rewardBps"] > 0 for r in records),
            "negativeRewards": sum(r["rewardBps"] < 0 for r in records),
            "meanRewardBps": float(np.mean([r["rewardBps"] for r in records])) if records else None})
    report["summary"] = summaries
    temporary = state / "report.json.tmp"
    temporary.write_text(json.dumps(report, indent=2, allow_nan=False), encoding="utf-8")
    replace_report(temporary, state / "report.json")
    lines = ["# Portfolio academy example run", "", f"Status: {report['status']}. Completed {len(completed)}/{expected} trials.",
             "", "Example data only. No trading qualification, model API usage, or wallet activity.", "",
             "Reward = (net return - drawdown) minus the equal-weight baseline's same score, in basis points.",
             "These are separate liquidated test windows; mean reward is not annualised portfolio performance.", "",
             "| Method | Windows | Positive rewards | Negative rewards | Mean reward (bps) |",
             "| --- | ---: | ---: | ---: | ---: |"]
    for item in summaries:
        lines.append(f"| {item['method']} | {item['windows']} | {item['positiveRewards']} | {item['negativeRewards']} | {item['meanRewardBps']} |")
    lines += ["", "Inspect report.json and academy.sqlite for individual windows, weights, losses, and failed attempts.",
              "Results remain research observations. No bot is promoted, deleted, or given capital by this exercise."]
    temporary = state / "report.md.tmp"
    temporary.write_text("\n".join(lines) + "\n", encoding="utf-8")
    replace_report(temporary, state / "report.md")
    return report


def run(state=DEFAULT_STATE, max_trials=108):
    if not 1 <= max_trials <= 108:
        raise ValueError("Trial budget must be 1..108")
    state.mkdir(parents=True, exist_ok=True)
    with exclusive_run(state / "run.lock"):
        lock = json.loads((HERE / "dependencies.lock.json").read_text())
        for item in lock["packages"]:
            if importlib.metadata.version(item["name"]) != item["version"]:
                raise ValueError("Dependency version differs from reviewed lock")
        returns = load_returns()
        metadata = {"config": CONFIG, "dataset": "skfolio bundled S&P500 selected-20 example",
                    "usage": "testing and examples only; stale selected universe, not investment evidence",
                    "firstReturnDate": str(returns.index[0]), "lastReturnDate": str(returns.index[-1]),
                    "assets": list(returns.columns), "dataDigest": digest(returns.to_csv().encode()),
                    "codeDigest": digest(Path(__file__).read_bytes()),
                    "dependencyDigest": digest(encoded(lock).encode())}
        plan = digest(encoded(metadata).encode())
        folds = list(WalkForward(train_size=CONFIG["trainBars"], test_size=CONFIG["testBars"]).split(returns))
        db = database(state / "academy.sqlite")
        try:
            # No other runner can hold the OS lock. Running rows are crashed attempts.
            db.execute("UPDATE attempts SET state='interrupted', finished=?, error='Previous process ended before recording a result' WHERE state='running'", (now(),))
            db.commit()
            worked = 0
            for fold, (training, test) in enumerate(folds):
                if training[-1] >= test[0]:
                    raise ValueError("Training/evaluation overlap")
                for method in METHODS:
                    trial = f"{fold:03d}:{method}"
                    previous = db.execute("SELECT state FROM attempts WHERE plan=? AND trial=?", (plan, trial)).fetchall()
                    if any(s[0] == "completed" for s in previous) or len(previous) >= CONFIG["maxAttempts"]:
                        continue
                    if worked >= max_trials:
                        break
                    attempt = db.execute("INSERT INTO attempts(plan,trial,started,state) VALUES(?,?,?,'running')", (plan, trial, now())).lastrowid
                    db.commit()
                    try:
                        weights = weights_for(method, returns.iloc[training])
                        result = score(weights, returns.iloc[test], CONFIG["costBps"])
                        baseline = score(np.full(returns.shape[1], 1 / returns.shape[1]), returns.iloc[test], CONFIG["costBps"])
                        reward = result["netReturnBps"] - result["maxDrawdownBps"] - baseline["netReturnBps"] + baseline["maxDrawdownBps"]
                        if abs(reward) < 1e-8:
                            reward = 0.0
                        result.update({"method": method, "weights": weights.tolist(), "baseline": baseline,
                                       "rewardBps": reward, "trainEnd": str(returns.index[training[-1]]),
                                       "testStart": str(returns.index[test[0]]), "testEnd": str(returns.index[test[-1]])})
                        db.execute("UPDATE attempts SET state='completed',finished=?,result=? WHERE id=?", (now(), encoded(result), attempt))
                    except Exception as error:
                        db.execute("UPDATE attempts SET state='failed',finished=?,error=? WHERE id=?", (now(), type(error).__name__ + ': ' + str(error)[:500], attempt))
                    db.commit()
                    worked += 1
                    write_report(db, state, plan, metadata, len(folds) * len(METHODS))
                if worked >= max_trials:
                    break
            report = write_report(db, state, plan, metadata, len(folds) * len(METHODS))
            return {k: report[k] for k in ("planId", "status", "expectedTrials", "completedTrials", "failedAttempts")} | {"newAttempts": worked}
        finally:
            db.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-trials", type=int, default=108)
    args = parser.parse_args()
    print(encoded(run(max_trials=args.max_trials)))
