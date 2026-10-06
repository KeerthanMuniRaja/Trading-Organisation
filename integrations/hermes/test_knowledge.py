from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from adapter import Settings, PINNED_REVISION, HermesError
from knowledge import validate_plan
from knowledge_worker import run_once
from runner import query_agent


def context():
    return {'kind':'knowledge-transfer-v1','bot':{'id':'student'},'task':'New research task',
            'lessons':[{'id':'lesson-1','authorBotId':'mentor','content':'Deduct costs','evidenceId':'evidence'}]}


def plan():
    return {'summary':'Cost lesson','application':'Apply costs to a fresh comparison','lessonIds':['lesson-1'],
            'checks':['Compare net returns'],'risks':['May not generalise']}


class KnowledgeTests(unittest.TestCase):
    def test_citations_and_closed_schema_reject_invented_knowledge_or_tools(self):
        self.assertEqual(validate_plan(plan(), context()), plan())
        for bad in ({**plan(),'lessonIds':['fabricated']},{**plan(),'lessonIds':['lesson-1']*2},
                    {**plan(),'tools':['shell']},{**plan(),'checks':[]},{**plan(),'application':'x'*501}):
            with self.assertRaises(HermesError): validate_plan(bad, context())

    def test_runner_uses_bot_context_and_no_tools_for_knowledge_task(self):
        class Agent:
            tools=[]
            valid_tool_names=[]
            def __init__(self, **kwargs):
                self.kwargs=kwargs
                assert kwargs['enabled_toolsets']==[] and kwargs['skip_memory']
            def run_conversation(self, value):
                assert json.loads(value)==context()
                assert 'recipient research bot' in self.kwargs['ephemeral_system_prompt']
                return {'completed':True,'final_response':json.dumps(plan())}
        with patch.dict(os.environ, {'HERMES_MODEL_API_KEY':'fixture-key'}):
            self.assertEqual(query_agent(Agent, {'task':'knowledge','context':context(),'model':'fixture','baseUrl':'http://127.0.0.1:8000/v1'}),plan())

    def ticket(self,settings):
        return {'id':'request','contextHash':'a'*64,'context':context(),
                'expiresAt':(datetime.now(timezone.utc)+timedelta(minutes=5)).isoformat(),
                'model':{'name':settings.model,'baseUrl':settings.base_url,'engine':'hermes-rd-v1','sourceRevision':PINNED_REVISION}}

    def test_lost_response_replays_without_regenerating_and_rejects_changed_task(self):
        settings=Settings(Path('/source'),Path('/python'),'fixture','http://127.0.0.1:8000/v1','fixture-key')
        client=Mock(base='http://127.0.0.1:3000',token='fixture-token')
        client.post.side_effect=[self.ticket(settings),{'authorised':True},{'recorded': True},TimeoutError()]
        proposer=Mock(return_value=plan())
        with tempfile.TemporaryDirectory() as directory:
            args=(client,settings,{'botId':'student','task':'one'},'stable-key',Path(directory))
            with self.assertRaises(TimeoutError):run_once(*args,proposer=proposer)
            original=client.post.call_args
            client.post.side_effect=[{'state':'awaiting-review'}]
            run_once(*args,proposer=proposer)
            self.assertEqual(client.post.call_args,original);proposer.assert_called_once()
            self.assertEqual([c.args[0] for c in client.post.call_args_list].count('/v1/development/inference-reports'),1)
            with self.assertRaises(HermesError):run_once(client,settings,{'botId':'student','task':'changed'},'stable-key',Path(directory),proposer=proposer)

    def test_uncertain_inference_requires_reconciliation(self):
        settings=Settings(Path('/source'),Path('/python'),'fixture','http://127.0.0.1:8000/v1','fixture-key')
        client=Mock(base='http://127.0.0.1:3000',token='fixture-token')
        client.post.side_effect=[self.ticket(settings),{'authorised':True}]
        proposer=Mock(side_effect=TimeoutError())
        with tempfile.TemporaryDirectory() as directory:
            args=(client,settings,{},'stable-key',Path(directory))
            with self.assertRaises(TimeoutError):run_once(*args,proposer=proposer)
            with self.assertRaisesRegex(HermesError,'Uncertain'):run_once(*args,proposer=proposer)
            proposer.assert_called_once()


if __name__ == '__main__': unittest.main()
