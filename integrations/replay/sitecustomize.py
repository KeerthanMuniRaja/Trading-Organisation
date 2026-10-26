"""Replay clock for Python (REPLAY-01): with this folder on PYTHONPATH and REPLAY_CLOCK_FILE set, every desk script lives
at the replay's virtual time (the same file and rule as scripts/replay-clock.mjs: the time in the file plus the real time
since it was written). Python loads sitecustomize by itself at start-up, so no desk code changes. It patches time.time,
datetime.datetime (now, utcnow, today) and datetime.date.today. Safety: it refuses unless the working folder is a replay
workspace (its path contains "replay"), so the live desk can never write at a false time. Without the variable it does
nothing.
"""
import os

_FILE = os.environ.get('REPLAY_CLOCK_FILE')
if _FILE:
    import datetime as _dt
    import json as _json
    import time as _time

    if 'replay' not in os.getcwd().lower():
        raise SystemExit('Replay clock refused: run from a replay workspace (a folder whose path contains "replay"), never the live project')
    _real_time = _time.time
    _cache = {'mtime': None, 'base': None}

    def _virtual():
        mtime = os.stat(_FILE).st_mtime
        if mtime != _cache['mtime']:
            with open(_FILE, encoding='utf-8') as handle:
                text = _json.load(handle)['now'].replace('Z', '+00:00')
            _cache.update(mtime=mtime, base=_RealDatetime.fromisoformat(text).timestamp())
        return _cache['base'] + (_real_time() - mtime)

    _RealDatetime, _RealDate = _dt.datetime, _dt.date

    class _ReplayDatetime(_RealDatetime):
        @classmethod
        def now(cls, tz=None):
            return cls.fromtimestamp(_virtual(), tz)

        @classmethod
        def utcnow(cls):
            return cls.fromtimestamp(_virtual(), _dt.timezone.utc).replace(tzinfo=None)

        @classmethod
        def today(cls):
            return cls.fromtimestamp(_virtual())

    class _ReplayDate(_RealDate):
        @classmethod
        def today(cls):
            return _RealDatetime.fromtimestamp(_virtual()).date()

    _virtual()  # fail at start-up, not mid-run, on a bad clock file
    _time.time = _virtual
    _dt.datetime = _ReplayDatetime
    _dt.date = _ReplayDate
