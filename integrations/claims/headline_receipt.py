"""Local freshness receipts; hashes bind files, not publisher truth or reviewer identity."""
from datetime import datetime, timedelta, timezone
import hashlib
import json

MAX_AGE = timedelta(minutes=5)


def receipt_path(path):
    return path.with_name(path.name + '.receipt.json')


def receipt(data, checked_at):
    return {'version': 1, 'checkedAt': checked_at.isoformat(),
            'expiresAt': (checked_at + MAX_AGE).isoformat(),
            'sha256': hashlib.sha256(data).hexdigest()}


def validate(data, value, now=None):
    now = now or datetime.now(timezone.utc)
    if not isinstance(value, dict) or set(value) != {'version', 'checkedAt', 'expiresAt', 'sha256'} or value['version'] != 1:
        raise ValueError('NEWS_RECEIPT_INVALID')
    checked = datetime.fromisoformat(value['checkedAt'])
    expires = datetime.fromisoformat(value['expiresAt'])
    if checked.utcoffset() is None or expires.utcoffset() is None or not checked <= now < expires or expires - checked != MAX_AGE:
        raise ValueError('NEWS_RECEIPT_EXPIRED_OR_INVALID')
    if value['sha256'] != hashlib.sha256(data).hexdigest():
        raise ValueError('NEWS_RECEIPT_CONTENT_MISMATCH')


def load(path, now=None):
    with path.open('rb') as handle:
        data = handle.read(5_000_001)
    with receipt_path(path).open('rb') as handle:
        metadata = handle.read(4097)
    if len(data) > 5_000_000 or len(metadata) > 4096:
        raise ValueError('NEWS_FILE_TOO_LARGE')
    validate(data, json.loads(metadata), now)
    return json.loads(data)
