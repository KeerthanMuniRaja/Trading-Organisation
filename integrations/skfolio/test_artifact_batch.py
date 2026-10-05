import unittest
from unittest.mock import Mock, patch
from artifact_batch import recover_batch


class BatchTests(unittest.TestCase):
    def test_input_is_bounded_unique_and_validated_before_any_work(self):
        with patch('artifact_batch.inspect_journal') as inspect:
            for value in ([], ['a'*64]*2, ['../escape'], [f'{i:064x}' for i in range(11)], 'a'*64):
                with self.assertRaises(ValueError):
                    recover_batch(Mock(), value, 'unused')
            inspect.assert_not_called()

    def test_one_failure_does_not_block_other_selected_journals(self):
        ids = ['a'*64, 'b'*64, 'c'*64]
        with patch('artifact_batch.inspect_journal', side_effect=[{'localStatus': 'submission-saved-unconfirmed'}, ValueError('secret'), {'localStatus': 'work-incomplete'}]), patch('artifact_batch.recover', return_value={'executionReporting': {'pending': 0}}) as recover:
            result = recover_batch(Mock(), ids, 'state')
        self.assertEqual([r['outcome'] for r in result['results']], ['completed', 'needs-attention', 'completed'])
        self.assertEqual(result['needsAttention'], 1)
        self.assertFalse(recover.call_args_list[0].kwargs['report_only'])
        self.assertTrue(recover.call_args_list[1].kwargs['report_only'])
        self.assertNotIn('secret', str(result))
        self.assertEqual(result['executedArtifacts'], 0)

    def test_reporting_outage_is_not_reported_as_success(self):
        with patch('artifact_batch.inspect_journal', return_value={'localStatus': 'acknowledgement-saved'}), patch('artifact_batch.recover', return_value={'executionReporting': {'pending': 2}}) as recover:
            result = recover_batch(Mock(), ['a'*64], 'state')
        self.assertEqual(result['results'][0]['outcome'], 'pending-reports')
        self.assertEqual(result['needsAttention'], 1)
        recover.assert_called_once()


if __name__ == '__main__':
    unittest.main()
