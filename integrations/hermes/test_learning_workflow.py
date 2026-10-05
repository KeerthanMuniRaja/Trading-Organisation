from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
from learning_workflow import cycle, run_cycles
from adapter import HermesError

class WorkflowTests(unittest.TestCase):
    def test_loop_is_bounded_and_stops_on_terminal_or_blocked_state(self):
        run=Mock(side_effect=[{'state':'awaiting-source-review'},{'progress':{'state':'halted'}}]);sleep=Mock()
        result=run_cycles(None,'workflow','unused',20,15,run=run,sleep=sleep)
        self.assertEqual(result['cyclesExecuted'],2);sleep.assert_called_once_with(15)
        for cycles,interval in [(0,15),(21,15),(True,15),(2,0)]:
            with self.assertRaises(HermesError):run_cycles(None,'workflow','unused',cycles,interval,run=run,sleep=sleep)
        self.assertEqual(run.call_count,2)
    def test_review_wait_needs_no_model_and_does_not_approve_anything(self):
        client=Mock(base='http://localhost',token='fixture');client.post.return_value={'state':'awaiting-source-review','action':None}
        with tempfile.TemporaryDirectory() as d, patch('learning_workflow.Settings.from_env',side_effect=AssertionError('No inference')):
            self.assertEqual(cycle(client,'workflow',Path(d))['state'],'awaiting-source-review')
        client.post.assert_called_once_with('/v1/learning/workflows/progress',{'workflowId':'workflow'})

    def test_lost_assessment_link_reuses_creation_and_attachment_keys(self):
        action={'action':{'stage':'assessment-create','body':{'requestId':'transfer'},'requestKey':'stable-key'}}
        client=Mock(base='http://localhost',token='fixture');client.post.side_effect=[action,{'assessmentId':'assessment'},TimeoutError()]
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(TimeoutError):cycle(client,'workflow',d)
            original=client.post.call_args_list[-2:]
            client.post.side_effect=[action,{'assessmentId':'assessment'},{'linked':True},{'state':'assessment-answer','action':None}]
            cycle(client,'workflow',d)
            self.assertEqual(client.post.call_args_list[-3:-1],original)

    def test_source_routes_through_durable_worker_before_linking(self):
        action={'action':{'stage':'source','body':{'botId':'mentor','evidenceId':'evidence'},'requestKey':'stable-key'}}
        client=Mock(base='http://localhost',token='fixture');client.post.side_effect=[action,{'linked':True},{'state':'awaiting-source-review','action':None}]
        with tempfile.TemporaryDirectory() as d, patch('learning_workflow.propose_once',return_value={'requestId':'source'}) as worker:
            cycle(client,'workflow',d,settings=object())
            self.assertEqual(worker.call_args.kwargs['workflow'],'sources')
            self.assertEqual(client.post.call_args_list[1].args[1],{'workflowId':'workflow','step':'source','referenceId':'source'})

    def test_unrecognised_stage_cannot_trigger_a_model_or_arbitrary_route(self):
        client=Mock(base='http://localhost',token='fixture');client.post.return_value={'action':{'stage':'withdraw','body':{},'requestKey':'key'}}
        with tempfile.TemporaryDirectory() as d, self.assertRaises(HermesError):cycle(client,'workflow',d)
        self.assertEqual(client.post.call_count,1)

if __name__=='__main__':unittest.main()
