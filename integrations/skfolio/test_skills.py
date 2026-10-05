import unittest
from unittest.mock import Mock
from skills import solve, examine, producer_hash


def scenario():
    return {"grossProfitPaise": -300, "feesPaise": 50, "slippagePaise": 25,
            "equityPaise": [10000, 12000, 9000, 11000], "cutoff": "2020-01-02T00:00:00Z",
            "records": [{"id": "record-0", "eventAt": "2020-01-01T00:00:00Z", "availableAt": "2020-01-02T00:00:00Z"},
                        {"id": "record-1", "eventAt": "2020-01-01T00:00:00Z", "availableAt": "2020-01-03T00:00:00Z"}],
            "control": {"halted": False, "evidenceVerified": True, "budget": 10, "required": 10}}


class SkillTests(unittest.TestCase):
    def test_version_is_declared_before_questions_and_echoed_on_submission(self):
        from unittest.mock import patch
        manifest = {"name": "test-solver", "version": "1", "kind": "deterministic", "sourceSha256": "a" * 64}
        client = Mock()
        client.post.side_effect = [{"attempt": {"id": "one", "rubric": "research-basics-v1", "challenge": scenario(), "producerHash": producer_hash(manifest)}}, {"state": "submitted"}]
        with patch("skills.producer", return_value=manifest):
            self.assertEqual(examine(client, "key"), {"status": "submitted", "attemptId": "one"})
        self.assertEqual(client.post.call_args_list[0].args[1], {"producer": manifest})
        self.assertEqual(client.post.call_args_list[1].args[1]["producerHash"], producer_hash(manifest))

    def test_mismatched_claim_cannot_receive_answers(self):
        client = Mock()
        client.post.return_value = {"attempt": {"id": "one", "rubric": "research-basics-v1", "producerHash": "wrong"}}
        with self.assertRaises(ValueError):
            examine(client, "key")
        self.assertEqual(client.post.call_count, 1)

    def test_costs_drawdown_and_information_available_at_cutoff(self):
        self.assertEqual(solve(scenario()), {"netProfitPaise": -375, "maxDrawdownBps": 2500,
                                          "eligibleRecordIds": ["record-0"], "action": "research"})

    def test_each_control_can_independently_require_abstention(self):
        for field, value in (("halted", True), ("evidenceVerified", False), ("budget", 9)):
            challenge = scenario()
            challenge["control"][field] = value
            self.assertEqual(solve(challenge)["action"], "wait")

    def test_unknown_rubric_cannot_submit_and_disabled_policy_is_idle(self):
        client = Mock()
        client.post.return_value = {"status": "disabled", "attempt": None}
        self.assertEqual(examine(client, "claim-key"), {"status": "disabled"})
        self.assertEqual(client.post.call_count, 1)
        client.post.return_value = {"attempt": {"rubric": "unknown"}}
        with self.assertRaises(ValueError):
            examine(client, "claim-key")
        self.assertEqual(client.post.call_count, 2)
