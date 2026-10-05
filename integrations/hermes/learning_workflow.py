"""One bounded workflow stage; independent judgement remains a separate review."""
import hashlib
import time
from pathlib import Path
from adapter import Settings, HermesError
from development_worker import locked
from knowledge_worker import run_once as propose_once
from knowledge import propose_knowledge
from source_learning import propose_lesson
from knowledge_assessment_worker import run_once as assess_once
from knowledge_assessment import propose_answers


def cycle(client, workflow_id, state, settings=None, source_proposer=propose_lesson,
          transfer_proposer=propose_knowledge, answerer=propose_answers):
    state = Path(state)
    state.mkdir(parents=True, exist_ok=True)
    identity = hashlib.sha256((client.base + '\n' + client.token + '\n' + workflow_id).encode()).hexdigest()
    with locked(state / (identity + '.lock')):
        progress = client.post('/v1/learning/workflows/progress', {'workflowId': workflow_id})
        action = progress.get('action')
        if action is None:
            return progress
        stage, body, key = action['stage'], action['body'], action['requestKey']
        if stage not in ('source', 'transfer', 'assessment-create', 'assessment-answer', 'assessment-grade'):
            raise HermesError('Unknown learning stage')
        if stage in ('source', 'transfer', 'assessment-answer'):
            settings = settings or Settings.from_env()
        if stage in ('source', 'transfer'):
            result = propose_once(client, settings, body, key, state / stage,
                                  proposer=source_proposer if stage == 'source' else transfer_proposer,
                                  workflow='sources' if stage == 'source' else 'knowledge')
            client.post('/v1/learning/workflows/links', {'workflowId': workflow_id, 'step': stage,
                        'referenceId': result['requestId']}, key + '-link')
        elif stage == 'assessment-create':
            result = client.post('/v1/learning/knowledge/assessments', body, key)
            client.post('/v1/learning/workflows/links', {'workflowId': workflow_id, 'step': 'assessment',
                        'referenceId': result['assessmentId']}, key + '-link')
        elif stage == 'assessment-answer':
            assess_once(client, settings, body['assessmentId'], state / 'assessments', proposer=answerer)
        else:
            client.post('/v1/learning/knowledge/assessments/grades', body, key)
        return {'workflowId': workflow_id, 'advancedStage': stage,
                'progress': client.post('/v1/learning/workflows/progress', {'workflowId': workflow_id})}


def run_cycles(client, workflow_id, state, cycles=1, interval_seconds=15, *, run=cycle, sleep=time.sleep):
    if type(cycles) is not int or not 1 <= cycles <= 20 or type(interval_seconds) is not int or not 5 <= interval_seconds <= 60:
        raise HermesError('Use 1-20 cycles and a 5-60 second interval')
    result = None
    for index in range(cycles):
        result = run(client, workflow_id, state)
        progress = result.get('progress', result)
        if progress['state'] in ('completed', 'rejected', 'cancelled', 'halted', 'policy-changed', 'support-withdrawn', 'assessment-expired'):
            break
        if index + 1 < cycles:
            sleep(interval_seconds)
    return {'cyclesExecuted': index + 1, 'last': result}
