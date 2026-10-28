"""Market pulse (AWARE-01): who is moving and why, and what the big players are doing, read from the news we collect.

Every headline the approved feeds brought in is read by fixed rules (no model, no network), across all NIFTY 500 names:
  movers        "Bandhan Bank shares jump 7% as Abu Dhabi's IHC explores stake": the company, up or down, the size and
                the reason the press gives (the clause after as / after / amid / on ...)
  big players   promoters, foreign investors (FII/FPI), domestic institutions (mutual funds, LIC), insiders, known
                investors, bulk and block deals: who, buy or sell (or pledge), which company, how much (Rs crore)
  flows         market-wide FII/DII buying or selling with an amount
  our shares    each desk share's last move against the basket, measured against its own recent swings; a big move
                with no news about the share in the two days before is flagged "unexplained"
Everything here is the press's account, unverified: the fact-checker verifies claims separately. It is context for the
agents and the owner, never evidence, and never a trading signal by itself.
  .local\\replay-venv\\Scripts\\python.exe integrations\\trading-desk\\market_pulse.py [--days 7]
"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import re
import statistics
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'claims'))
import batch  # noqa: E402
import claims  # noqa: E402
import daily  # noqa: E402
import datasets  # noqa: E402

HEADLINES = daily.ROOT / '.local' / 'world' / 'headline-history.json'
OUT = daily.ROOT / '.local' / 'world' / 'market-pulse.json'
UNEXPLAINED_SIGMA = 2.0   # a desk share's move against the basket this many of its own daily swings is "big"

UP = r'jumps?|surges?|soars?|zooms?|rall(?:y|ies)|rises?|climbs?|gains?|spurts?|advances?|rockets?|skyrockets?'
DOWN = r'falls?|drops?|slips?|declines?|tumbles?|plunges?|sinks?|crash(?:es)?|slumps?|tanks?|skids?|slides?|dips?|plummets?'
MOVE = re.compile(r'\b(?P<verb>' + UP + '|' + DOWN + r')\b(?:\s+(?:by|up to|over|nearly|about|almost|as much as|more than|around|another))?'
                  r'\s+(?P<pct>\d{1,3}(?:\.\d+)?)\s?(?:%|per\s?cent)', re.IGNORECASE)
SHARES = re.compile(r'\b(?:shares?|stocks?|scrip|share price|stock price|m-cap|market cap)\b', re.IGNORECASE)
METRIC = re.compile(r'\b(?:profit|PAT|revenue|income|sales|margin|EBITDA|earnings|net|order book|orders|dividend|NII|loan|deposits?|'
                    r'volumes?|exports?|production|GMP|subscri\w+)\b', re.IGNORECASE)
PERIOD = re.compile(r'(?P<period>YTD|in (?:a|one|two|three|six|\d+) (?:sessions?|days?|weeks?|months?|years?)|this (?:week|month|year)|'
                    r'since \w+|from (?:its )?52-week low|against (?:its )?IPO price|intraday|today)\b', re.IGNORECASE)
FORECAST = re.compile(r'\b(?:can|could|may|might|to|seen|expected|likely|set to|poised to|target)\s+(?:\w+\s+)?$', re.IGNORECASE)
# a following capitalised word makes it another company ("Cyient DLM" is not Cyient), except these
NEXT_OK = {'Shares', 'Share', 'Stock', 'Stocks', 'Ltd', 'Limited', 'Q1', 'Q2', 'Q3', 'Q4', 'IPO', 'AGM', 'Board', 'Results', 'Q2FY27', 'Q3FY27'}
REASON = re.compile(r'\b(?:as|after|on|amid|following|despite|post|ahead of|due to|over)\b\s+(?P<why>[^|;:?!]{6,160})', re.IGNORECASE)
ACTORS = {
    'promoter': r'\bpromoters?\b',
    'foreign-investors': r'\b(?:FIIs?|FPIs?|foreign (?:portfolio |institutional )?investors?)\b',
    'domestic-institutions': r'\b(?:DIIs?|[Mm]utual [Ff]unds?|MFs?|LIC|insurers?)\b',
    'known-investor': r'\b(?:ace investor|Kacholia|Kedia|Singhania|Jhunjhunwala|Damani|Dolly Khanna|Porinju|Mukul Agrawal|Radhakishan)\b',
    'insider': r'\binsiders?\b',
    'bulk-or-block-deal': r'\b(?:block|bulk) deals?\b',
}
ACTIONS = {
    'pledge': r'\b(?:pledg\w*|invok\w* pledge)\b',
    'sell': r'\b(?:sell(?:s|ing)?|sold|offloads?|trims?|cuts? stake|reduces? stake|exits?|dumps?|stake sale|divests?|pares|net sellers?|outflows?)\b',
    'buy': r'\b(?:buy(?:s|ing)?|bought|raises? stake|increases? stake|ups stake|hikes? stake|adds?|acquires?|picks? up|invests?|'
           r'pumps? in|purchases?|net buyers?|inflows?)\b',
}
AMOUNT = re.compile(r'(?:₹|Rs\.?\s?|INR\s?)\s?(?P<n>\d[\d,]*(?:\.\d+)?)\s?(?P<unit>lakh crore|crore|cr\b)', re.IGNORECASE)


# ---------- naming the companies ----------
def aliases(rows=None):
    """[(alias, symbol)], longest first. The desk's own aliases (with their exclusions, e.g. 'SBI' never 'SBI Life'),
    then every NIFTY 500 name without 'Ltd.' and '(India)', and without a trailing 'India' when something is left.
    Case-sensitive: headlines capitalise company names, and 'Indian Bank' must not match 'Indian bank stocks'."""
    out = {}
    for symbol, (_, names) in claims.COMPANIES.items():
        for name in names:
            out.setdefault(name, symbol)
    for symbol, name in (rows if rows is not None else datasets.nifty500()).items():
        core = re.sub(r'\s*\((?:I|India)\)', '', name)
        core = re.sub(r'\s+(?:Ltd\.?|Limited)$', '', core).strip()
        for alias in {core, core[:-6].strip() if core.endswith(' India') else core}:
            if len(alias) >= 3:
                out.setdefault(alias, symbol)
    return sorted(out.items(), key=lambda kv: (-len(kv[0]), kv[0]))


def named(text, alias_list):
    """Companies named in a text, in order of appearance; a longer name masks the shorter ones inside it."""
    taken, found = [False] * len(text), []
    for alias, symbol in alias_list:
        exclude = f'(?!{claims.NOT_FOLLOWED_BY[alias]})' if alias in claims.NOT_FOLLOWED_BY else ''
        for m in re.finditer(r'(?<![A-Za-z0-9])' + re.escape(alias) + r'(?![A-Za-z0-9])' + exclude, text):
            nxt = re.match(r"\s+([A-Z][A-Za-z0-9]*)", text[m.end():])
            if nxt and nxt.group(1) not in NEXT_OK and not (len(alias) > 12 and alias.count(' ') >= 2):
                continue  # "Cyient DLM", "Tata Motors Passenger Vehicles": a longer name we do not know
            if not any(taken[m.start():m.end()]):
                taken[m.start():m.end()] = [True] * (m.end() - m.start())
                found.append((m.start(), symbol))
    return [s for _, s in sorted(found)]


# ---------- reading one headline ----------
def mover(title, alias_list):
    """A share move the headline reports, or None: the company named before the move, the direction, size and reason."""
    for m in MOVE.finditer(title):
        head = title[:m.start()]
        before = named(head, alias_list)
        if not before:
            continue  # an index, a sector or a company outside the NIFTY 500: nothing to relate it to
        # between the company and the verb: it must be its shares that moved, not its profit or revenue
        alias = next(a for a, s in alias_list if s == before[-1] and a in head)
        gap = head[head.rfind(alias) + len(alias):]
        if METRIC.search(gap) or not (SHARES.search(gap) or SHARES.search(title[m.end():m.end() + 12])):
            continue
        if FORECAST.search(head):
            continue  # "can soar 143% in a bull case" is a forecast, not a move
        why = REASON.search(title, m.end()) or REASON.search(head)
        period = PERIOD.search(re.split(r'[,;|:]', title[m.end():m.end() + 40])[0])  # "drops 2%, down 30% YTD": today's 2%
        up = re.fullmatch(UP, m.group('verb'), re.IGNORECASE) is not None
        reason = re.split(r'\.\s+[A-Z]|\s+-\s+', why.group('why'))[0].strip(' ,.-—') if why else None
        return {'symbol': before[-1], 'direction': 'up' if up else 'down', 'pct': float(m.group('pct')),
                'period': period.group('period') if period else None, 'why': reason}
    return None


def player(title, alias_list):
    """Big-player activity the headline reports, or None: who, which action, which company (None: market-wide), how much."""
    actors = [a for a, pattern in ACTORS.items() if re.search(pattern, title, re.IGNORECASE)]
    found = [a for a, pattern in ACTIONS.items() if re.search(pattern, title, re.IGNORECASE)]
    action = 'mixed' if {'buy', 'sell'} <= set(found) else (found[0] if found else None)  # "adds 3 stocks, trims 13"
    if not actors or (action is None and actors != ['bulk-or-block-deal'] and 'bulk-or-block-deal' not in actors):
        return None
    if actors == ['insider'] and action is None:
        return None  # "insider leak probe" is not a trade
    # the amount nearest to who acted ("Rs 4 lakh crore rally, Rs 6,500 crore FII buying": the FIIs bought Rs 6,500 crore)
    spots = [m.start() for a in actors for m in re.finditer(ACTORS[a], title, re.IGNORECASE)]
    amounts = sorted(AMOUNT.finditer(title), key=lambda a: min(abs(a.start() - s) for s in spots))
    crore = None
    if amounts:
        a = amounts[0]
        crore = float(a.group('n').replace(',', '')) * (100_000 if a.group('unit').lower() == 'lakh crore' else 1)
    companies = named(title, alias_list)
    market_wide = not companies and bool(re.search(r'\b(?:FIIs?|FPIs?|DIIs?)\b', title)) and action in ('buy', 'sell')
    return {'actors': actors, 'action': action or 'deal', 'symbols': companies, 'amountCrore': crore, 'marketWide': market_wide}


# ---------- our shares: the move and the news before it ----------
def desk_moves(cache=daily.DAILY, headlines=(), lookback=60, sigma=UNEXPLAINED_SIGMA):
    """Each desk share's last session against the equal-weight basket, in units of its own daily swings (60 sessions),
    with the headlines naming it in the two days up to that session. A big move with none is 'unexplained'."""
    import portfolio_daily as pd
    loaded = daily.load(sorted(datasets.UNIVERSE), cache)
    dates, table = pd.aligned(loaded)
    if len(dates) < lookback + 2:
        return []
    def rel(i, s):  # the share's close-to-close return minus the basket's
        r = {x: table[x][dates[i]]['closePaise'] / table[x][dates[i - 1]]['closePaise'] - 1 for x in table}
        return r[s] - statistics.fmean(r.values())
    last, out = len(dates) - 1, []
    day = dates[last]
    since = (datetime.fromisoformat(day) - timedelta(days=2)).date().isoformat()
    for s in sorted(table):
        history = [rel(i, s) for i in range(last - lookback, last)]
        swing = statistics.pstdev(history) or None
        move = rel(last, s)
        news = [h['title'] for h in headlines if s in (h.get('symbols') or []) and since <= str(h['publishedAt'])[:10] <= day]
        size = abs(move) / swing if swing else None
        out.append({'symbol': s, 'date': day, 'vsBasketPct': round(100 * move, 2), 'sigmas': None if size is None else round(size, 1),
                    'big': bool(size and size >= sigma), 'news': news[:3],
                    'unexplained': bool(size and size >= sigma and not news)})
    return sorted(out, key=lambda r: -(r['sigmas'] or 0))


# ---------- the pulse ----------
def build(headlines_path=HEADLINES, out=OUT, cache=daily.DAILY, days=7, now=None, rows=None):
    now = now or datetime.now(timezone.utc)
    items = json.loads(Path(headlines_path).read_text(encoding='utf-8')) if Path(headlines_path).exists() else []
    recent = [h for h in items if h.get('publishedAt') and datetime.fromisoformat(str(h['publishedAt'])) >= now - timedelta(days=days)]
    alias_list = aliases(rows)
    names = rows if rows is not None else datasets.nifty500()
    sectors = datasets.industries() if rows is None else {}
    movers, players, flows = [], [], []
    for h in sorted(recent, key=lambda h: str(h['publishedAt']), reverse=True):
        base = {'publishedAt': str(h['publishedAt']), 'source': h.get('source'), 'title': h['title']}
        m = mover(h['title'], alias_list)
        if m:
            movers.append({**m, 'company': names.get(m['symbol'], m['symbol']), 'sector': sectors.get(m['symbol']),
                           'desk': m['symbol'] in datasets.UNIVERSE, **base})
        p = player(h['title'], alias_list)
        if p and p['marketWide']:
            flows.append({**{k: p[k] for k in ('actors', 'action', 'amountCrore')}, **base})
        elif p:  # with no NIFTY 500 name it is kept unlinked: still what the big players are doing
            players.append({**{k: v for k, v in p.items() if k != 'marketWide'}, 'companies': [names.get(s, s) for s in p['symbols']],
                            'desk': any(s in datasets.UNIVERSE for s in p['symbols']), **base})
    ours = desk_moves(cache, items) if cache else []
    report = {'generatedAt': now.isoformat(), 'windowDays': days, 'headlinesRead': len(recent),
              'counts': {'movers': len(movers), 'up': sum(m['direction'] == 'up' for m in movers), 'down': sum(m['direction'] == 'down' for m in movers),
                         'bigPlayers': len(players), 'flows': len(flows), 'unexplainedDeskMoves': sum(r['unexplained'] for r in ours)},
              'movers': movers, 'bigPlayers': players, 'flows': flows, 'deskMoves': ours,
              'note': 'The press\'s account, read by fixed rules: unverified, context only, never evidence or a signal by itself.'}
    batch.save(Path(out), report)
    return report


def for_share(symbol, path=OUT, limit=3, as_of=None):
    """What the pulse says about one share (for the debate): its reported moves and big-player activity, newest first.
    With `as_of` (the proposal's time) nothing published later is shown, so a replay of a past day never sees the future."""
    if not Path(path).exists():
        return None
    r = json.loads(Path(path).read_text(encoding='utf-8'))
    s = symbol if symbol.endswith('.NS') else symbol + '.NS'
    cut = datetime.fromisoformat(as_of.replace('Z', '+00:00')) if as_of else None
    known = lambda item: cut is None or datetime.fromisoformat(item['publishedAt']) <= cut  # noqa: E731
    moves = [{k: m[k] for k in ('publishedAt', 'direction', 'pct', 'period', 'why', 'title')} for m in r['movers'] if m['symbol'] == s and known(m)][:limit]
    players = [{k: p[k] for k in ('publishedAt', 'actors', 'action', 'amountCrore', 'title')} for p in r['bigPlayers'] if s in p['symbols'] and known(p)][:limit]
    own = next((d for d in r.get('deskMoves', []) if d['symbol'] == s and (cut is None or d['date'] <= cut.date().isoformat())), None)
    if not (moves or players or own):
        return None
    return {'reportedMoves': moves, 'bigPlayers': players, 'lastSession': own, 'asOf': r['generatedAt'],
            'note': 'press reports read by rules: unverified context, never evidence'}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--days', type=int, default=7, choices=range(1, 31))
    args = parser.parse_args(argv)
    r = build(days=args.days)
    show = lambda m: (f"{m['company']} {'+' if m['direction'] == 'up' else '-'}{m['pct']:g}%" + (f" {m['period']}" if m['period'] else '')  # noqa: E731
                      + (f" ({m['why']})" if m['why'] else ''))
    print(json.dumps({'headlinesRead': r['headlinesRead'], 'counts': r['counts'],
                      'topMovers': [show(m) for m in sorted(r['movers'], key=lambda m: -m['pct'])[:8]],
                      'bigPlayers': [f"{', '.join(p['actors'])} {p['action']} {', '.join(p['companies']) or '(not a NIFTY 500 name)'}"
                                     + (f" Rs {p['amountCrore']:,.0f} cr" if p['amountCrore'] else '') for p in r['bigPlayers'][:8]],
                      'flows': [f"{', '.join(f['actors'])} {f['action']}" + (f" Rs {f['amountCrore']:,.0f} cr" if f['amountCrore'] else '') for f in r['flows'][:5]],
                      'deskMoves': [f"{d['symbol']} {d['vsBasketPct']:+}% vs basket ({d['sigmas']} sigma)" + (' UNEXPLAINED' if d['unexplained'] else '')
                                    for d in r['deskMoves'][:4]]}, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
