"""Desk bots learn from their own past results: factual lessons computed by code from earlier windows only.

Lessons are statistics of what actually happened after each bot's past calls; they contain no model-written claims
and no information from the windows they will later be tested on. Each bot receives only its own lessons.
These are experiment-local lessons, not organisation knowledge: entering shared knowledge would still require the
backend's evidence and independent review process.
"""
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import desk  # noqa: E402

ROLES = ('trend-analyst', 'reversion-analyst', 'portfolio-manager')


def outcome(bars, i, every):
    forward = desk.bps(bars[min(i + every, len(bars) - 1)]['closePaise'], bars[i]['closePaise'])
    return 'rose' if forward > desk.COST_BPS_ROUND_TRIP else 'fell' if forward < -desk.COST_BPS_ROUND_TRIP else 'flat'


def experience(windows, every):
    """windows: [(bars, decisions)] from earlier periods. Returns per-role outcome counts, nothing else."""
    stats = {role: {} for role in desk.ANALYSTS}
    signals = {role: {} for role in desk.ANALYSTS}
    manager = {'meetings': 0, 'held': 0, 'missedRises': 0, 'entries': 0, 'goodEntries': 0, 'badEntries': 0}
    for bars, decisions in windows:
        for d in decisions:
            if d.get('type') != 'desk-meeting' or 'portfolio-manager' not in d.get('bots', {}):
                continue
            result = outcome(bars, d['index'], every)
            for role in desk.ANALYSTS:
                log = d['bots'][role]
                if log.get('outcome') != 'valid':
                    continue
                key = f"{log['opinion']['stance']}/{log['opinion']['conviction']}"
                bucket = stats[role].setdefault(key, {'rose': 0, 'fell': 0, 'flat': 0})
                bucket[result] += 1
                stance = log['opinion']['stance']
                signals[role].setdefault(stance, {'rose': 0, 'fell': 0, 'flat': 0})[result] += 1
            pm = d['bots']['portfolio-manager']
            if pm.get('outcome') != 'valid' or d.get('allowed') != ['buy', 'hold']:
                continue
            manager['meetings'] += 1
            if pm['decision']['action'] == 'hold':
                manager['held'] += 1
                manager['missedRises'] += result == 'rose'
            else:
                manager['entries'] += 1
                manager['goodEntries'] += result == 'rose'
                manager['badEntries'] += result != 'rose'
    return {'analysts': stats, 'signals': signals, 'manager': manager}


def describe(counts):
    n = sum(counts.values())
    return f"n={n}: next hour rose beyond costs {counts['rose']}, fell beyond costs {counts['fell']}, stayed within costs {counts['flat']}"


def lessons(exp, period):
    """Turns counts into short factual statements per role. Small samples are labelled as such."""
    out = {}
    for role in desk.ANALYSTS:
        lines = [f"Your past calls ({period}) and what followed:"]
        for key, counts in sorted(exp['analysts'][role].items()):
            note = ' (small sample)' if sum(counts.values()) < 5 else ''
            lines.append(f"- {key}: {describe(counts)}{note}")
        if len(lines) == 1:
            lines.append('- No valid past calls recorded.')
        out[role] = lines
    m = exp['manager']
    lines = [f"Your past decisions when flat ({period}): {m['meetings']} meetings, held {m['held']}, entered {m['entries']}.",
             f"- While you held, the next hour rose beyond costs {m['missedRises']} times.",
             f"- Your entries: {m['goodEntries']} were followed by a rise beyond costs, {m['badEntries']} were not."]
    for role in desk.ANALYSTS:
        for stance, counts in sorted(exp['signals'][role].items()):
            if stance != 'neutral':
                lines.append(f"- When the {role} was {stance}: {describe(counts)}.")
    out['portfolio-manager'] = lines
    return out


def role_of(system):
    if 'trend analyst' in system:
        return 'trend-analyst'
    if 'mean-reversion analyst' in system:
        return 'reversion-analyst'
    return 'portfolio-manager'


def with_lessons(llm, role_lessons):
    """Adds each bot's own lessons to its input. No bot receives another bot's lessons."""
    def call(system, user, schema):
        payload = json.loads(user)
        payload['lessonsFromYourPastResults'] = role_lessons.get(role_of(system), [])
        return llm(system, json.dumps(payload, allow_nan=False), schema)
    return call
