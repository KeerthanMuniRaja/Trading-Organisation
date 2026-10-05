import unittest
from unittest.mock import Mock
from paired import run_pair
from skills import solve, producer_hash
from test_skills import scenario

A = {"name": "fixture", "version": "1", "sourceSha256": "a" * 64, "kind": "deterministic"}
B = {**A, "version": "2", "sourceSha256": "b" * 64}


def work():
    return {"experimentId": "experiment", "baselineHash": producer_hash(A), "candidateHash": producer_hash(B),
            "rubric": "research-basics-v1", "planHash": "c" * 64,
            "cases": [{"id": str(i), "challenge": scenario()} for i in range(8)]}


class PairedTests(unittest.TestCase):
    def test_same_cases_are_isolated_and_submitted_together_without_client_grades(self):
        client = Mock()
        payload = work()
        client.post.side_effect = [payload, {"status": "submitted"}]

        def mutating(challenge):
            challenge["feesPaise"] = 0
            return solve(challenge)

        self.assertEqual(run_pair(client, "experiment", A, mutating, B, solve), {"status": "submitted"})
        body = client.post.call_args_list[1].args[1]
        self.assertEqual(len(body["results"]), 8)
        self.assertEqual(body["results"][0]["baseline"]["netProfitPaise"], -325)
        self.assertEqual(body["results"][0]["candidate"]["netProfitPaise"], -375)
        self.assertEqual(payload["cases"][0]["challenge"]["feesPaise"], 50)
        self.assertEqual(set(body), {"experimentId", "baselineHash", "candidateHash", "planHash", "results"})

    def test_version_mismatch_cannot_call_solver_or_submit(self):
        client, solver = Mock(), Mock()
        client.post.return_value = {**work(), "candidateHash": "wrong"}
        with self.assertRaises(ValueError):
            run_pair(client, "experiment", A, solver, B, solver)
        solver.assert_not_called()
        self.assertEqual(client.post.call_count, 1)

    def test_solver_failure_cannot_submit_partial_results(self):
        client = Mock()
        client.post.return_value = work()
        failing = Mock(side_effect=RuntimeError("fixture failure"))
        with self.assertRaises(RuntimeError):
            run_pair(client, "experiment", A, solve, B, failing)
        self.assertEqual(client.post.call_count, 1)

    def test_duplicates_and_identical_versions_are_refused(self):
        client = Mock()
        payload = work()
        payload["cases"][-1] = payload["cases"][0]
        client.post.return_value = payload
        with self.assertRaises(ValueError):
            run_pair(client, "experiment", A, solve, B, solve)
        client.reset_mock()
        with self.assertRaises(ValueError):
            run_pair(client, "experiment", A, solve, A, solve)
        client.post.assert_not_called()
