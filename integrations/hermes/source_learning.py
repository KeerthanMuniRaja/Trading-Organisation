"""Cited lesson proposals from already reviewed article snapshots."""
import json
from adapter import HermesError, invoke


def validate_lesson(value, context):
    if not isinstance(value, dict) or set(value) != {'lesson', 'quote', 'limitation'}:
        raise HermesError('Unexpected source lesson fields')
    for field, maximum in [('lesson', 500), ('quote', 500), ('limitation', 300)]:
        if not isinstance(value[field], str) or not 1 <= len(value[field].strip()) <= maximum:
            raise HermesError('Invalid source lesson text')
    if len(value['quote'].strip()) < 10 or value['quote'] not in context['article']['content']:
        raise HermesError('Quote must match the supplied article exactly')
    return value


def propose_lesson(settings, context):
    if (not isinstance(context, dict) or context.get('kind') != 'source-lesson-v1'
            or not isinstance(context.get('article'), dict)
            or not isinstance(context['article'].get('content'), str)
            or len(context['article']['content']) > 4000 or len(json.dumps(context).encode()) > 48000):
        raise HermesError('Invalid source learning context')
    return invoke(settings, {'source': str(settings.source), 'model': settings.model, 'baseUrl': settings.base_url,
                            'task': 'source-lesson', 'context': context}, lambda value: validate_lesson(value, context))
