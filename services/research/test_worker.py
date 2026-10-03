import unittest
from datetime import datetime, timedelta, timezone
from worker import backtest, research, evaluate, Client, run_once
from unittest.mock import patch
from urllib.error import HTTPError
from email.message import Message


def bars(prices, offset=0):
    start = datetime(2025, 1, 1, tzinfo=timezone.utc)
    return [{"timestamp": (start + timedelta(days=i+offset)).isoformat(), "closePaise": str(p)} for i, p in enumerate(prices)]


class WorkerTests(unittest.TestCase):
    def test_no_same_bar_lookahead(self):
        result = backtest(bars([100] * 29 + [10000]), 2, 15)
        self.assertEqual(result["netReturnBps"], 0)
        self.assertEqual(result["turnover"], 0)

    def test_costs_and_final_exit_are_charged(self):
        rising = bars(range(10000, 14000, 100))
        cheap = backtest(rising, 2, 1)
        expensive = backtest(rising, 2, 100)
        self.assertLess(expensive["netReturnBps"], cheap["netReturnBps"])
        self.assertEqual(expensive["turnover"], 2)

    def test_falling_market_stays_in_cash(self):
        self.assertEqual(backtest(bars(range(14000, 10000, -100)), 2, 15)["netReturnBps"], 0)

    def test_training_logs_all_trials(self):
        report = research({"training": bars(range(10000, 16000, 100)), "costBps": 15})
        self.assertEqual(len(report["trainingReport"]["trials"]), 4)
        self.assertEqual(report["candidate"]["lookback"], 2)

    def test_separate_holdout_evaluation(self):
        result = evaluate({"candidate": {"kind": "momentum", "lookback": 2}, "warmup": bars(range(10000, 12000, 100)), "holdout": bars(range(12000, 18000, 100), 20), "costBps": 15, "datasetDigest": "a" * 64})
        self.assertEqual(result["observations"], 60)
        self.assertGreater(result["netReturnBps"], 0)
        self.assertEqual(result["datasetDigest"], "a" * 64)

    def test_rejects_overlapping_periods(self):
        with self.assertRaises(ValueError):
            backtest(bars([100, 200]), 2, 15, bars([50, 75]))

    def test_rejects_unsafe_origin_and_arbitrary_plugin(self):
        with self.assertRaises(ValueError):
            Client("http://example.com", "a" * 43)
        with self.assertRaises(ValueError):
            evaluate({"candidate": {"kind": "execute-python", "lookback": 2}})

    def test_claim_recovers_from_transient_failure(self):
        client = Client("http://127.0.0.1:3000", "a" * 43)
        with patch.object(client, "_send", side_effect=[TimeoutError(), {"job": None}]) as send, patch("worker.time.sleep"):
            self.assertFalse(run_once(client, "researcher"))
            self.assertEqual(send.call_count, 2)

    def test_completion_retry_preserves_payload_and_idempotency(self):
        client = Client("http://127.0.0.1:3000", "a" * 43)
        job = {"id": "job", "leaseToken": "lease", "kind": "research", "payload": {"training": bars(range(10000, 16000, 100)), "costBps": 15}}
        with patch.object(client, "_send", side_effect=[{"job": job}, TimeoutError(), {"state": "completed"}]) as send, patch("worker.time.sleep"):
            self.assertTrue(run_once(client, "researcher"))
            first, retry = send.call_args_list[1], send.call_args_list[2]
            self.assertEqual(first.args[:3], retry.args[:3])

    def test_permission_failure_is_not_retried(self):
        client = Client("http://127.0.0.1:3000", "a" * 43)
        with patch.object(client, "_send", side_effect=HTTPError("http://localhost", 403, "stale lease", Message(), None)) as send:
            with self.assertRaises(HTTPError):
                client.post("/v1/jobs/completions", {}, "same-key")
            self.assertEqual(send.call_count, 1)


if __name__ == "__main__":
    unittest.main()
