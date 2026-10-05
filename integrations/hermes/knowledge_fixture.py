"""Actual HTTP transfer with a deterministic model stand-in; never invokes a provider."""
import json
import os
from pathlib import Path
import sys
import tempfile
from adapter import Settings
from development_worker import Client
from knowledge_worker import run_once


class LostResponseClient(Client):
    lose = True
    def post(self, path, body, key=None):
        response = super().post(path, body, key)
        if path.endswith(('/proposals','/answers','/links')) and self.lose:
            self.lose = False
            raise OSError('Injected response loss')
        return response


def main():
    body=json.loads(sys.argv[1])
    client=LostResponseClient(os.environ['API_URL'],os.environ['API_TOKEN'])
    settings=Settings(Path('/unused'),Path('/unused'),'Qwen/Qwen3.5-9B','http://127.0.0.1:8000/v1','fixture-only')
    calls=[]
    assessment='assessmentId' in body
    source='evidenceId' in body
    if assessment:
        from knowledge_assessment_worker import run_once as run_assessment
    def propose(settings, context):
        calls.append(context)
        if 'article' in context:
            return {'lesson':'Deduct fees and slippage before comparing returns.',
                    'quote':context['article']['content'],'limitation':'A general cost principle does not establish profitability.'}
        if 'cases' in context:
            results=[]
            for case in context['cases']:
                c=case['challenge'];peak=0;drawdown=0
                for n in c['equityPaise']:
                    peak=max(peak,n);drawdown=max(drawdown,(peak-n)/peak*10000)
                control=c['control']
                results.append({'caseId':case['id'],'answers':{
                    'netProfitPaise':c['grossProfitPaise']-c['feesPaise']-c['slippagePaise'],
                    'maxDrawdownBps':drawdown,'eligibleRecordIds':[r['id'] for r in c['records'] if r['eventAt']<=c['cutoff'] and r['availableAt']<=c['cutoff']],
                    'action':'research' if not control['halted'] and control['evidenceVerified'] and control['budget']>=control['required'] else 'wait'}})
            return {'answers':results}
        return {'summary':'Use the mentor cost lesson','application':'Compare a fresh strategy after fees and slippage.',
                'lessonIds':[l['id'] for l in context['lessons']], 'checks':['Net result must include all configured costs'],
                'risks':['One lesson does not establish profitability']}
    with tempfile.TemporaryDirectory() as directory:
        if 'workflowId' in body:
            from learning_workflow import cycle
            kwargs={'settings':settings,'source_proposer':propose,'transfer_proposer':propose,'answerer':propose}
            try:
                result=cycle(client,body['workflowId'],Path(directory),**kwargs)
            except OSError:
                result=cycle(client,body['workflowId'],Path(directory),**kwargs)
            assert len(calls)<=1
            print(json.dumps({'result':result,'modelStandInCalls':len(calls),'realModelInference':False}))
            return
        args=(client,settings,body['assessmentId'],Path(directory)) if assessment else (client,settings,body,'knowledge-fixture-request',Path(directory))
        run=run_assessment if assessment else run_once
        try:
            run(*args,proposer=propose,**({'workflow':'sources'} if source else {}))
            raise AssertionError('Expected injected response loss')
        except OSError:
            pass
        result=run(*args,proposer=propose,**({'workflow':'sources'} if source else {}))
        assert len(calls)==1
        print(json.dumps({'result':result,'modelStandInCalls':len(calls),'realModelInference':False}))


if __name__=='__main__': main()
