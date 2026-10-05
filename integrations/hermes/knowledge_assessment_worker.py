"""One durable inference for an already-issued assessment. Never self-grade."""
from datetime import datetime,timezone
import hashlib
import json
from adapter import HermesError,PINNED_REVISION
from development_worker import locked,save
from knowledge_assessment import propose_answers,validate_answers


def run_once(client,settings,assessment_id,directory,proposer=propose_answers):
    identity={'base':client.base,'credentialHash':hashlib.sha256(client.token.encode()).hexdigest(),'assessmentId':assessment_id}
    stable=hashlib.sha256(json.dumps(identity,sort_keys=True).encode()).hexdigest()
    directory.mkdir(parents=True,exist_ok=True);path=directory/(stable+'.json')
    with locked(directory/(stable+'.lock')):
        if path.exists():
            record=json.loads(path.read_text(encoding='utf-8'))
            if record['identity']!=identity:raise HermesError('Assessment identity differs')
        else:
            work=client.post('/v1/learning/knowledge/assessments/work',{'assessmentId':assessment_id})
            if work.get('assessmentId')!=assessment_id:raise HermesError('Unexpected assessment')
            record={'identity':identity,'work':work,'inferenceStarted':False};save(path,record)
        work=record['work'];profile=work['model']
        if (profile['name']!=settings.model or profile['baseUrl'].rstrip('/')!=settings.base_url.rstrip('/')
                or profile['sourceRevision']!=PINNED_REVISION or profile['engine']!='hermes-rd-v1'):
            raise HermesError('Assessment model profile differs')
        context={k:work[k] for k in ('botId','rubric','plan','lessons','cases')}
        if 'answers' not in record:
            if record['inferenceStarted']:raise HermesError('Uncertain inference; automatic regeneration forbidden')
            if datetime.fromisoformat(work['expiresAt'].replace('Z','+00:00'))<=datetime.now(timezone.utc):raise HermesError('Assessment expired')
            if client.post('/v1/learning/knowledge/assessments/work',{'assessmentId':assessment_id})!=work:raise HermesError('Assessment changed')
            record['inferenceStarted']=True;save(path,record)
            record['answers']=validate_answers(proposer(settings,context),context);save(path,record)
        value=validate_answers(record['answers'],context)
        return client.post('/v1/learning/knowledge/assessments/answers',{'assessmentId':assessment_id,**value},'knowledge-answers-'+stable)
