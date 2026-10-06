from datetime import datetime,timedelta,timezone
from pathlib import Path
import tempfile
import json
import os
import unittest
from unittest.mock import Mock,patch
from adapter import Settings,PINNED_REVISION,HermesError
from knowledge_assessment import validate_answers
from knowledge_assessment_worker import run_once
from runner import query_agent


def answers():
    return {'answers':[{'caseId':str(i),'answers':{'netProfitPaise':1,'maxDrawdownBps':0,'eligibleRecordIds':[],'action':'wait'}} for i in range(4)]}


class AssessmentTests(unittest.TestCase):
    def setUp(self):
        self.settings=Settings(Path('/unused'),Path('/unused'),'fixture','http://127.0.0.1:8000/v1','fixture')
        self.work={'assessmentId':'a','botId':'student','rubric':'research-basics-v1','plan':{},'lessons':[],
                   'cases':[{'id':str(i)} for i in range(4)],'expiresAt':(datetime.now(timezone.utc)+timedelta(minutes=10)).isoformat(),
                   'model':{'name':'fixture','baseUrl':self.settings.base_url,'engine':'hermes-rd-v1','sourceRevision':PINNED_REVISION}}

    def test_strict_answers_exclude_fabricated_scores_and_cases(self):
        self.assertEqual(validate_answers(answers(),self.work),answers())
        for change in ('score','duplicate','nan','bool'):
            value=answers()
            if change=='score':value['score']=100
            if change=='duplicate':value['answers'][1]['caseId']='0'
            if change=='nan':value['answers'][0]['answers']['maxDrawdownBps']=float('nan')
            if change=='bool':value['answers'][0]['answers']['netProfitPaise']=True
            with self.assertRaises(HermesError):validate_answers(value,self.work)

    def test_assessment_runner_has_no_tools_or_self_grading_output(self):
        class Agent:
            tools=[]
            valid_tool_names=[]
            def __init__(self,**options):
                assert options['enabled_toolsets']==[] and options['max_tokens']==2048
                assert 'No scores' in options['ephemeral_system_prompt']
            def run_conversation(self,payload):
                assert len(json.loads(payload)['cases'])==4
                return {'completed':True,'final_response':json.dumps(answers())}
        with patch.dict(os.environ,{'HERMES_MODEL_API_KEY':'fixture'}):
            result=query_agent(Agent,{'task':'knowledge-assessment','context':self.work,'model':'fixture','baseUrl':self.settings.base_url})
            self.assertEqual(result,answers())

    def test_accepted_but_lost_response_does_not_repeat_inference(self):
        client=Mock(base='http://127.0.0.1:3000',token='fixture');client.post.side_effect=[self.work,self.work,TimeoutError()]
        proposer=Mock(return_value=answers())
        with tempfile.TemporaryDirectory() as directory:
            args=(client,self.settings,'a',Path(directory))
            with self.assertRaises(TimeoutError):run_once(*args,proposer=proposer)
            original=client.post.call_args;client.post.side_effect=[{'state':'awaiting-grade'}]
            run_once(*args,proposer=proposer)
            self.assertEqual(client.post.call_args,original);proposer.assert_called_once()

    def test_inference_outcome_is_reported_once_for_the_assessment_ticket(self):
        work={**self.work,'inferenceRequestId':'inference-ticket'}
        client=Mock(base='http://127.0.0.1:3000',token='fixture');client.post.side_effect=[work,work,{'recorded':True},TimeoutError()]
        proposer=Mock(return_value=answers())
        with tempfile.TemporaryDirectory() as directory:
            args=(client,self.settings,'a',Path(directory))
            with self.assertRaises(TimeoutError):run_once(*args,proposer=proposer)
            report=client.post.call_args_list[2]
            self.assertEqual(report.args[0],'/v1/development/inference-reports')
            self.assertEqual(report.args[1]['requestId'],'inference-ticket')
            self.assertEqual(report.args[1]['promptVersion'],'36548d679ac444e2')
            client.post.side_effect=[{'state':'awaiting-grade'}]
            run_once(*args,proposer=proposer)
            self.assertEqual(client.post.call_args.args[0],'/v1/learning/knowledge/assessments/answers')
            self.assertEqual(client.post.call_count,5);proposer.assert_called_once()

    def test_uncertain_inference_cannot_reset_attempt(self):
        client=Mock(base='http://127.0.0.1:3000',token='fixture');client.post.side_effect=[self.work,self.work]
        proposer=Mock(side_effect=TimeoutError())
        with tempfile.TemporaryDirectory() as directory:
            args=(client,self.settings,'a',Path(directory))
            with self.assertRaises(TimeoutError):run_once(*args,proposer=proposer)
            with self.assertRaisesRegex(HermesError,'Uncertain'):run_once(*args,proposer=proposer)
            proposer.assert_called_once()


if __name__=='__main__':unittest.main()
