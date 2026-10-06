"""Model answers for fresh transfer diagnostics; the backend owns grading."""
import math
import json
from adapter import HermesError,invoke
import contracts

COST_TERMS=[sign+name for name in ('grossProfitPaise','feesPaise','slippagePaise') for sign in '+-']


def _method_values(a):
    """research-methods-v1: chosen computations only; the backend derives every number from them."""
    if not isinstance(a,dict) or set(a)!={'costTerms','drawdownMethod','timingRule','action'}:
        raise HermesError('Unexpected method answer fields')
    terms=a['costTerms']
    if (not isinstance(terms,list) or not 1<=len(terms)<=3 or any(t not in COST_TERMS for t in terms)
            or len({t[1:] for t in terms})!=len(terms)):
        raise HermesError('Invalid cost terms')
    if (a['drawdownMethod'] not in contracts.METHOD_OPTIONS['drawdownMethod'] or a['timingRule'] not in contracts.METHOD_OPTIONS['timingRule']
            or a['action'] not in ('research','wait')):
        raise HermesError('Invalid method choice')


def _numeric_values(a):
    if not isinstance(a,dict) or set(a)!={'netProfitPaise','maxDrawdownBps','eligibleRecordIds','action'}:
        raise HermesError('Unexpected answer fields')
    n,d,records=a['netProfitPaise'],a['maxDrawdownBps'],a['eligibleRecordIds']
    if (type(n) is not int or not -1000000<=n<=1000000 or type(d) not in (int,float) or not math.isfinite(d) or not 0<=d<=10000
            or a['action'] not in ('research','wait') or not isinstance(records,list) or len(records)>6
            or any(not isinstance(r,str) or r not in [f'record-{i}' for i in range(6)] for r in records) or len(set(records))!=len(records)):
        raise HermesError('Invalid answer values')


def validate_answers(value,context):
    """The context's rubric selects the answer contract; anything else is refused."""
    check=_method_values if contracts.assessment_task(context)=='knowledge-assessment-methods' else _numeric_values
    if not isinstance(value,dict) or set(value)!={'answers'} or not isinstance(value['answers'],list) or len(value['answers'])!=4:
        raise HermesError('Expected four assessment answers')
    ids=[]
    for result in value['answers']:
        if not isinstance(result,dict) or set(result)!={'caseId','answers'} or not isinstance(result['caseId'],str):
            raise HermesError('Invalid case answer')
        ids.append(result['caseId']);check(result['answers'])
    if sorted(ids)!=sorted(c['id'] for c in context['cases']):
        raise HermesError('Answer each supplied case exactly once')
    return value


def propose_answers(settings,context):
    if not isinstance(context,dict) or not isinstance(context.get('cases'),list) or len(context['cases'])!=4 or len(json.dumps(context).encode())>48000:
        raise HermesError('Invalid bounded assessment context')
    return invoke(settings,{'source':str(settings.source),'model':settings.model,'baseUrl':settings.base_url,
                           'task':contracts.assessment_task(context),'context':context},lambda value:validate_answers(value,context))
