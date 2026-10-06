"""Durable per-request inference outcome reports. A report records what happened; it grants nothing."""
import time

from adapter import HermesError, PINNED_REVISION, USAGE
import contracts

ENGINE = 'hermes-' + PINNED_REVISION[:12]
ROUTE = '/v1/development/inference-reports'


def timed_inference(record, path, save, task, call, engine=ENGINE):
    """Runs one inference and saves its outcome report before returning or re-raising. Never retries."""
    started = time.perf_counter()
    base = {'engine': engine, 'promptVersion': contracts.prompt_version(task)}
    usage = {}
    token = USAGE.set(usage)
    try:
        value = call()
    except Exception as exc:
        record['inferenceReport'] = {**base, 'outcome': 'failed', 'latencyMs': elapsed(started),
                                     'failureCode': 'HERMES_FAILED' if isinstance(exc, HermesError) else 'INFERENCE_FAILED'}
        save(path, record)
        raise
    finally:
        USAGE.reset(token)
    # The direct engine reports provider token counts; the pinned Hermes adapter does not, so the backend reserves instead.
    record['inferenceReport'] = {**base, 'outcome': 'completed', 'latencyMs': elapsed(started), **usage}
    return value


def elapsed(started):
    return min(3_600_000, max(0, round((time.perf_counter() - started) * 1000)))


def mark_uncertain(record, path, save, task, engine=ENGINE):
    """An inference started without a saved outcome: record that once, without guessing what the provider did."""
    if 'inferenceReport' not in record:
        record['inferenceReport'] = {'engine': engine, 'promptVersion': contracts.prompt_version(task),
                                     'outcome': 'uncertain', 'failureCode': 'INFERENCE_INTERRUPTED'}
        save(path, record)


def flush_report(client, record, path, save, request_id, key):
    """Best effort and replay-safe: an unacknowledged report is resent with the same key on the next run.

    Reporting failures never block proposal submission; older backends without the route simply keep it pending.
    """
    if 'inferenceReport' not in record or record.get('inferenceReported'):
        return record.get('inferenceReported', False)
    try:
        client.post(ROUTE, {'requestId': request_id, **record['inferenceReport']}, key)
    except Exception:
        return False
    record['inferenceReported'] = True
    save(path, record)
    return True
