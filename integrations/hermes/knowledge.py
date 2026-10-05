"""Cited cross-bot learning plans. A proposal is not demonstrated learning."""
import json
from adapter import HermesError, invoke

DEFAULT_MODEL = 'Qwen/Qwen3.5-9B'


def validate_plan(value, context):
    if not isinstance(value, dict) or set(value) != {'summary', 'application', 'lessonIds', 'checks', 'risks'}:
        raise HermesError('Invalid knowledge plan fields')
    for name in ('summary', 'application'):
        if not isinstance(value[name], str) or not 1 <= len(value[name].strip()) <= 500:
            raise HermesError('Invalid knowledge plan text')
    for name in ('checks', 'risks'):
        if not isinstance(value[name], list) or not 1 <= len(value[name]) <= 5 or any(not isinstance(v, str) or not 1 <= len(v.strip()) <= 200 for v in value[name]):
            raise HermesError('Invalid knowledge plan checks/risks')
    expected = sorted(l['id'] for l in context['lessons'])
    if not isinstance(value['lessonIds'], list) or any(not isinstance(v, str) for v in value['lessonIds']) or sorted(value['lessonIds']) != expected:
        raise HermesError('Cite exactly the supplied lessons')
    return value


def propose_knowledge(settings, context):
    if (not isinstance(context, dict) or context.get('kind') != 'knowledge-transfer-v1'
            or not isinstance(context.get('lessons'), list) or not 1 <= len(context['lessons']) <= 5
            or len(json.dumps(context).encode()) > 48000):
        raise HermesError('Invalid knowledge context')
    request = {'source': str(settings.source), 'model': settings.model, 'baseUrl': settings.base_url,
               'task': 'knowledge', 'context': context}
    return invoke(settings, request, lambda value: validate_plan(value, context))
