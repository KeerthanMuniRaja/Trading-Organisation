"""Post-trade reflections (LEARN-03): every scored proposal becomes a factual lesson for the bot that made it, so each bot
remembers its own results (the memory of a trading firm, as in TradingAgents' settled-decision reflections). No model.

For each proposal whose outcome the backend has scored:
  1. the RESEARCHER writes the reflection from the record and the steward-checked daily cache:
     - what the bot did (action, share, conviction, horizon), and its thesis;
     - how the share moved (the backend's own score) and how the equal-weight basket moved over the same days;
     - the alpha (share minus basket, in percentage points) and whether the call was right against cash;
     - one fixed takeaway chosen by rule from those numbers;
     and proposes it as a lesson for that bot, citing the proposal's verified evidence;
  2. the EVALUATOR, a different identity, rebuilds the text itself from its own reads and verifies the lesson only on an
     exact match (content-bound review).
Lessons enter the bot's knowledge like any other; later decisions and knowledge transfer can draw on them.
  .local\\replay-venv\\Scripts\\python.exe integrations\\trading-desk\\reflections.py
"""
from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import daily  # noqa: E402
import eod_trader  # noqa: E402
import signal_scorer as sc  # noqa: E402

STATE = daily.ROOT / '.local' / 'trading-desk' / 'reflections.json'


def window(cache, symbol, created_at, horizon_days, now):
    """The scorer's own window for this call: the review-day close is not needed; the exit is the first settled session at
    or after created + horizon (signal_scorer.exit_bar). Returns (start_day, exit_day) or None."""
    dataset = eod_trader.dataset_for(cache, symbol)
    if not dataset:
        return None
    bar = sc.exit_bar(dataset['bars'], created_at, horizon_days, now)
    if not bar:
        return None
    start = created_at[:10]
    before = [b for b in dataset['bars'] if b['date'] <= start]
    return (before[-1]['date'] if before else None), bar['date']


def basket_move(cache, start_day, exit_day):
    """The equal-weight basket's move (percent) from the start-day close to the exit-day close, over shares with both."""
    moves = []
    for symbol in sorted(daily.datasets.UNIVERSE):
        dataset = eod_trader.dataset_for(cache, symbol.removesuffix('.NS'))
        if not dataset:
            continue
        closes = {b['date']: b['closePaise'] for b in dataset['bars']}
        if start_day in closes and exit_day in closes:
            moves.append(closes[exit_day] / closes[start_day] - 1)
    return round(100 * sum(moves) / len(moves), 2) if moves else None


def takeaway(action, correct, alpha):
    if action == 'enter-long':
        if correct and alpha is not None and alpha > 0:
            return 'The call worked and beat simply holding the basket: the reasoning held up this time.'
        if correct:
            return 'The call made money but did not beat the basket: holding everything would have done as well or better.'
        return 'The call lost against cash: re-check what the thesis assumed before making the same call again.'
    if action == 'exit':
        return 'Selling was right: the price fell afterwards.' if correct else 'Selling was early: the price rose afterwards.'
    return 'Standing aside was right.' if correct else 'Standing aside missed a profitable move.'


def reflection(signal, basket, exit_day):
    move = signal['outcome']['moveBps'] / 100
    alpha = None if basket is None else round(move - basket, 2)
    basket_text = 'the basket could not be compared (missing closes)' if basket is None else \
        f'the equal-weight basket moved {basket:+.2f}% over the same days, an alpha of {alpha:+.2f} points'
    return (f"Result of {signal['botId']}'s {signal['action']} call on NSE:{signal['symbol']}, proposed {signal['createdAt'][:10]} "
            f"({signal['conviction']} conviction, {signal['horizonDays']}-day horizon), thesis: \"{signal['thesis'][:200]}\". "
            f"By {exit_day} the share had moved {move:+.2f}% and {basket_text}. "
            f"Judged {'right' if signal['outcome']['correct'] else 'wrong'} against holding cash. "
            f"{takeaway(signal['action'], signal['outcome']['correct'], alpha)}")


def scored(base, token, opener):
    """Every scored proposal, all pages."""
    out, before = [], None
    while True:
        page = sc.post(base, token, '/v1/trading/signals/query', {'limit': 200, **({'before': before} if before else {})}, opener)
        out += [s for s in page['signals'] if s.get('outcome') and s.get('review') and s.get('evidenceIds')]
        before = page.get('nextBefore')
        if not before:
            return out


def build(signal, cache, now):
    w = window(cache, signal['symbol'], signal['createdAt'], signal['horizonDays'], now)
    if not w or not w[0]:
        return None
    return reflection(signal, basket_move(cache, w[0], w[1]), w[1])


def run(env=os.environ, cache=daily.DAILY, opener=None, now=None, state_path=STATE):
    from urllib import request as urlrequest
    opener = opener or urlrequest.urlopen
    now = now or datetime.now(timezone.utc)
    reporter, checker = sc.principals(env, 'researcher'), sc.principals(env, 'evaluator')
    state = json.loads(state_path.read_text(encoding='utf-8')) if state_path.exists() else {}
    results = []
    for signal in scored(*reporter, opener):
        if signal['id'] in state:
            continue
        text = build(signal, cache, now)
        if text is None:
            results.append({'signalId': signal['id'], 'state': 'waiting', 'reason': 'its window is not in the daily data yet'})
            continue
        evidence = signal['evidenceIds'][0]
        lesson = sc.post(*reporter, '/v1/lessons', {'botId': signal['botId'], 'content': text, 'evidenceId': evidence}, opener)
        # the evaluator's own reconstruction: the same record read with its own credential, the same cache
        mine = next((s for s in scored(*checker, opener) if s['id'] == signal['id']), None)
        if mine is None or build(mine, cache, now) != text:
            results.append({'signalId': signal['id'], 'state': 'not-verified', 'reason': 'the evaluator could not reproduce the reflection'})
            state[signal['id']] = {'lessonId': lesson['id'], 'verified': False}
        else:
            sc.post(*checker, '/v1/lessons/reviews', {'lessonId': lesson['id'], 'expected': {'content': text, 'evidenceId': evidence, 'botId': signal['botId']}}, opener)
            state[signal['id']] = {'lessonId': lesson['id'], 'verified': True}
            results.append({'signalId': signal['id'], 'botId': signal['botId'], 'state': 'reflected', 'lessonId': lesson['id']})
        state_path.parent.mkdir(parents=True, exist_ok=True)
        state_path.write_text(json.dumps(state, indent=2), encoding='utf-8')
    return results


if __name__ == '__main__':
    print(json.dumps(run(), indent=2))
