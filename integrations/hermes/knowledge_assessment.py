"""Model answers for fresh transfer diagnostics; the backend owns grading."""
import math
import json
from adapter import HermesError,invoke


def validate_answers(value,context):
    if not isinstance(value,dict) or set(value)!={'answers'} or not isinstance(value['answers'],list) or len(value['answers'])!=4:
        raise HermesError('Expected four assessment answers')
    ids=[]
    for result in value['answers']:
        if not isinstance(result,dict) or set(result)!={'caseId','answers'} or not isinstance(result['caseId'],str):
            raise HermesError('Invalid case answer')
        ids.append(result['caseId']);a=result['answers']
        if not isinstance(a,dict) or set(a)!={'netProfitPaise','maxDrawdownBps','eligibleRecordIds','action'}:
            raise HermesError('Unexpected answer fields')
        n,d,records=a['netProfitPaise'],a['maxDrawdownBps'],a['eligibleRecordIds']
        if (type(n) is not int or not -1000000<=n<=1000000 or type(d) not in (int,float) or not math.isfinite(d) or not 0<=d<=10000
                or a['action'] not in ('research','wait') or not isinstance(records,list) or len(records)>6
                or any(not isinstance(r,str) or r not in [f'record-{i}' for i in range(6)] for r in records) or len(set(records))!=len(records)):
            raise HermesError('Invalid answer values')
    if sorted(ids)!=sorted(c['id'] for c in context['cases']):
        raise HermesError('Answer each supplied case exactly once')
    return value


def propose_answers(settings,context):
    if not isinstance(context,dict) or not isinstance(context.get('cases'),list) or len(context['cases'])!=4 or len(json.dumps(context).encode())>48000:
        raise HermesError('Invalid bounded assessment context')
    return invoke(settings,{'source':str(settings.source),'model':settings.model,'baseUrl':settings.base_url,
                           'task':'knowledge-assessment','context':context},lambda value:validate_answers(value,context))
