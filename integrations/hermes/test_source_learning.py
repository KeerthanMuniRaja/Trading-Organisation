from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
from adapter import Settings, PINNED_REVISION, HermesError
from source_learning import validate_lesson
from knowledge_worker import run_once
from runner import query_agent

CONTEXT={'kind':'source-lesson-v1','bot':{'id':'mentor'},'article':{'content':'Fees and slippage reduce net returns.'}}
PLAN={'lesson':'Account for costs.','quote':'Fees and slippage reduce net returns.','limitation':'Not a profitability guarantee.'}

class SourceLearningTests(unittest.TestCase):
    def test_exact_citations_and_schema(self):
        self.assertEqual(validate_lesson(PLAN,CONTEXT),PLAN)
        for bad in ({**PLAN,'quote':'Invented source quote'},{**PLAN,'verified':True},{**PLAN,'limitation':''}):
            with self.assertRaises(HermesError):validate_lesson(bad,CONTEXT)

    def test_runner_has_no_tools_and_marks_source_as_untrusted(self):
        class Agent:
            tools=[]
            valid_tool_names=[]
            def __init__(self,**kwargs):
                assert kwargs['enabled_toolsets']==[] and kwargs['max_tokens']==1024
                assert 'untrusted data' in kwargs['ephemeral_system_prompt']
            def run_conversation(self,value):
                assert json.loads(value)==CONTEXT
                return {'completed':True,'final_response':json.dumps(PLAN)}
        with patch.dict(os.environ,{'HERMES_MODEL_API_KEY':'fixture'}):
            self.assertEqual(query_agent(Agent,{'task':'source-lesson','context':CONTEXT,'model':'fixture','baseUrl':'http://127.0.0.1:8000/v1'}),PLAN)

    def fixture(self):
        settings=Settings(Path('/unused'),Path('/unused'),'fixture','http://127.0.0.1:8000/v1','fixture')
        client=Mock(base='http://127.0.0.1:3000',token='fixture')
        ticket={'id':'request','contextHash':'a'*64,'context':CONTEXT,'expiresAt':(datetime.now(timezone.utc)+timedelta(minutes=5)).isoformat(),
                'model':{'name':settings.model,'baseUrl':settings.base_url,'engine':'hermes-rd-v1','sourceRevision':PINNED_REVISION}}
        return settings,client,ticket

    def test_response_loss_reuses_saved_lesson_without_model_repeat(self):
        settings,client,ticket=self.fixture();client.post.side_effect=[ticket,{'authorised':True},{'recorded': True},TimeoutError()];proposer=Mock(return_value=PLAN)
        with tempfile.TemporaryDirectory() as directory:
            args=(client,settings,{'botId':'mentor','evidenceId':'evidence'},'source-key',Path(directory))
            with self.assertRaises(TimeoutError):run_once(*args,proposer=proposer,workflow='sources')
            original=client.post.call_args;self.assertEqual(original.args[0],'/v1/learning/sources/proposals')
            client.post.side_effect=[{'lessonId':'lesson','state':'awaiting-review'}]
            run_once(*args,proposer=proposer,workflow='sources');self.assertEqual(client.post.call_args,original);proposer.assert_called_once()
            self.assertEqual(client.post.call_args_list[2].args[1]['promptVersion'],'937eae52aa513e7f')

    def test_uncertain_inference_is_not_regenerated(self):
        settings,client,ticket=self.fixture();client.post.side_effect=[ticket,{'authorised':True}];proposer=Mock(side_effect=TimeoutError())
        with tempfile.TemporaryDirectory() as directory:
            args=(client,settings,{},'source-key',Path(directory))
            with self.assertRaises(TimeoutError):run_once(*args,proposer=proposer,workflow='sources')
            with self.assertRaisesRegex(HermesError,'Uncertain'):run_once(*args,proposer=proposer,workflow='sources')
            proposer.assert_called_once()

if __name__=='__main__':unittest.main()
