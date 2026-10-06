"""Freeze discovered lessons before issuing one budgeted knowledge proposal."""
import hashlib
import json
import re
from uuid import UUID

from adapter import HermesError
from development_worker import locked, save


def selected_lessons(result, bot_id):
    if (not isinstance(result, dict) or result.get('scope') != 'current-reviewed-cross-bot-lessons'
            or result.get('botId') != bot_id or result.get('modelInvoked') is not False):
        raise HermesError('Unexpected knowledge discovery response')
    ids, lessons = result.get('suggestedLessonIds'), result.get('lessons')
    if (not isinstance(ids, list) or len(ids) > 5 or not isinstance(lessons, list) or len(lessons) > 5
            or any(not isinstance(item, str) for item in ids) or len(set(ids)) != len(ids)):
        raise HermesError('Invalid discovered lesson selection')
    for item in ids:
        try:
            if str(UUID(item)) != item:
                raise ValueError()
        except (ValueError, AttributeError):
            raise HermesError('Invalid discovered lesson ID') from None
        if not any(isinstance(lesson, dict) and lesson.get('id') == item
                   and isinstance(lesson.get('author_bot_id'), str)
                   and lesson['author_bot_id'] != bot_id for lesson in lessons):
            raise HermesError('Selection must reference a returned cross-bot lesson')
    return ids


def run_discovered(client, body, request_key, directory, settings_factory, *, proposal_runner=None):
    if (not isinstance(body, dict) or set(body) != {'botId', 'query', 'task'}
            or not isinstance(body['botId'], str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', body['botId'])
            or not isinstance(body['query'], str) or not 3 <= len(body['query'].strip()) <= 200
            or not isinstance(body['task'], str) or not 1 <= len(body['task'].strip()) <= 500
            or not isinstance(request_key, str) or not re.fullmatch(r'[A-Za-z0-9_-]{8,100}', request_key)):
        raise HermesError('Invalid discovered-learning request')
    if proposal_runner is None:
        from knowledge_worker import run_once
        proposal_runner = run_once
    directory.mkdir(parents=True, exist_ok=True)
    # Key owns this local journal slot; changed backend/credential/body cannot silently adopt it.
    stable = hashlib.sha256(request_key.encode()).hexdigest()
    identity = {'origin': client.base, 'credentialHash': hashlib.sha256(client.token.encode()).hexdigest(),
                'requestKey': request_key, 'body': body}
    path = directory / (stable + '.json')
    with locked(directory / (stable + '.lock')):
        if path.exists():
            with path.open('rb') as handle:
                raw = handle.read(65537)
            if len(raw) > 65536:
                raise HermesError('Discovery journal exceeds capacity')
            record = json.loads(raw)
            if record.get('identity') != identity:
                raise HermesError('Saved discovery inputs or backend identity differ')
        else:
            discovery = client.post('/v1/learning/knowledge/discover',
                                    {'botId': body['botId'], 'query': body['query'], 'limit': 5})
            ids = selected_lessons(discovery, body['botId'])
            record = {'identity': identity, 'lessonIds': ids}
            if not ids:
                record['outcome'] = {'state': 'no-matching-lessons', 'modelInvoked': False, 'reviewRequired': False}
            save(path, record)
        if 'outcome' in record:
            return record['outcome']
        # Selection is never refreshed after persistence; the backend rechecks support on request/preflight.
        proposal_body = {'botId': body['botId'], 'task': body['task'], 'lessonIds': record['lessonIds']}
        result = proposal_runner(client, settings_factory(), proposal_body, 'discovered-' + stable,
                                 directory / 'proposals')
        if not isinstance(result, dict) or result.get('state') != 'awaiting-review':
            raise HermesError('Knowledge proposal was not acknowledged')
        record['outcome'] = {'state': 'awaiting-review', 'proposal': result,
                             'selectedLessonIds': record['lessonIds'], 'reviewRequired': True,
                             'demonstratedLearning': False, 'fitnessChanged': False}
        save(path, record)
        return record['outcome']
