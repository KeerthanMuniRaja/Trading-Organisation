"""Information chains: from news about an economic driver to the shares it may affect, labelled and tested.

The knowledge design asks for transmission maps (driver -> affected companies) where an inferred relationship is
always labelled as inferred (docs/knowledge-base/03-knowledge-graph.md, 04-research-and-decisions.md). This module:
  expand  Adds linked shares to verified headlines. A headline that names a share stays direct. A headline that
          mentions a driver (crude, repo rate, rupee, ...) also reaches the linked shares, titled
          "[inferred link: <driver>]" so no bot mistakes the link for a fact. The output has the desk's headline format,
          so the news analyst can read it unchanged.
  study   Tests whether each link carries information: after a headline about the driver, do the linked shares move
          further from the basket than they usually do? Direction-free (a link says "may affect", not "up" or "down"),
          from the next session's open, with the bot-fitness sign test against each share's own typical move.
Links live in impact_links.json (reviewed, editable). Nothing here fetches anything. Research only.
  .local\\replay-venv\\Scripts\\python.exe integrations\\trading-desk\\chains.py expand --headlines .local\\claims\\auto\\verified-headlines.json
  .local\\replay-venv\\Scripts\\python.exe integrations\\trading-desk\\chains.py study --headlines <dated headline history>.json
"""
from __future__ import annotations

import argparse
from bisect import bisect_right
import json
from pathlib import Path
import re
import statistics
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import batch  # noqa: E402
import daily  # noqa: E402
import portfolio_daily as pd  # noqa: E402

LINKS = Path(__file__).resolve().parent / 'impact_links.json'
REGIONS = {'IN', 'US', 'CN', 'EU', 'GB', 'JP', 'WORLD'}  # where a driver originates; absent means India
OUT = daily.ROOT / '.local' / 'trading-desk' / 'chains'
HORIZON = 5  # sessions


def load_links(path=LINKS):
    data = json.loads(Path(path).read_text(encoding='utf-8'))
    universe = set(daily.datasets.UNIVERSE)
    for link in data['links']:
        if not (re.fullmatch(r'[a-z0-9-]{1,40}', link['driver']) and link['keywords'] and set(link['symbols']) <= universe
                and link['basis'] and link.get('region', 'IN') in REGIONS):
            raise ValueError(f"Invalid link {link.get('driver')!r}")
    return data['links']


def matches(title, keywords):
    text = title.lower()
    return any(re.search(r'(?<![a-z0-9])' + re.escape(k.lower()) + r'(?![a-z0-9])', text) for k in keywords)


def validate(items):
    """The desk's headline shape, except that a headline may name no share (driver news such as a repo-rate decision)."""
    from datetime import datetime
    universe = set(daily.datasets.UNIVERSE)
    if not isinstance(items, list) or len(items) > 50_000:
        raise ValueError('Expected a list of at most 50,000 headlines')
    for h in items:
        if not (isinstance(h, dict) and set(h) == {'publishedAt', 'source', 'title', 'symbols'}
                and isinstance(h['source'], str) and 0 < len(h['source']) <= 80 and isinstance(h['title'], str)
                and 0 < len(h['title']) <= 240 and isinstance(h['symbols'], list) and set(h['symbols']) <= universe):
            raise ValueError('Invalid headline')
        if datetime.fromisoformat(h['publishedAt']).utcoffset() is None:
            raise ValueError('Headline times need a UTC offset')
    return items


def expand(headlines, links):
    """Direct headlines unchanged, plus one inferred copy per matching driver for its linked shares not already named.
    Headlines that name no share and match no driver are dropped: the desk could not route them."""
    out = []
    for h in headlines:
        if h['symbols']:
            out.append(h)
        for link in links:
            extra = [s for s in link['symbols'] if s not in h['symbols']]
            if extra and matches(h['title'], link['keywords']):
                out.append({'publishedAt': h['publishedAt'], 'source': h['source'],
                            'title': f"[inferred link: {link['driver']}] {h['title']}"[:240], 'symbols': extra})
    return out


def study(headlines, links, table, dates, horizon=HORIZON):
    """Per driver: linked shares' absolute move against the basket after its headlines, compared with each share's
    median absolute move over all windows of the same length. Above the median is a 'win' for the link."""
    import fitness
    opens = {s: [table[s][d]['openPaise'] for d in dates] for s in table}

    def excess(s, a):
        basket = sum(opens[x][a + horizon] / opens[x][a] - 1 for x in table) / len(table)
        return abs(opens[s][a + horizon] / opens[s][a] - 1 - basket)
    typical = {s: statistics.median(excess(s, a) for a in range(len(dates) - horizon)) for s in table}
    report = {}
    for link in links:
        moves, seen = [], set()
        for h in headlines:
            if not matches(h['title'], link['keywords']):
                continue
            a = bisect_right(dates, h['publishedAt'][:10])  # the next session's open: news after a close acts the next day
            if a + horizon >= len(dates):
                continue
            for s in link['symbols']:
                if (s, a) not in seen:  # several headlines about one driver on one day are one event
                    seen.add((s, a))
                    moves.append(excess(s, a) - typical[s])
        wins, losses = sum(m > 0 for m in moves), sum(m < 0 for m in moves)
        report[link['driver']] = {'events': len(moves), 'aboveTypicalMove': wins, 'belowTypicalMove': losses,
                                  'averageExtraMovePct': round(100 * sum(moves) / len(moves), 2) if moves else None,
                                  'pValue': round(fitness.sign_test(wins, losses), 4) if moves else None,
                                  'verdict': {'adds-value': 'link-carries-information', 'worse-than-baseline': 'linked-shares-move-less',
                                              'no-detectable-skill': 'no-detectable-effect'}.get(fitness.verdict(wins, losses),
                                                                                                  'insufficient-evidence')}
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    for name in ('expand', 'study'):
        p = sub.add_parser(name)
        p.add_argument('--headlines', type=Path, required=True)
        p.add_argument('--links', type=Path, default=LINKS)
    args = parser.parse_args(argv)
    headlines = validate(json.loads(args.headlines.read_text(encoding='utf-8')))
    links = load_links(args.links)
    OUT.mkdir(parents=True, exist_ok=True)
    if args.command == 'expand':
        result = expand(headlines, links)
        batch.save(OUT / 'linked-headlines.json', result)
        print(f'{len(headlines)} verified headlines -> {len(result)} with inferred links; written to {OUT / "linked-headlines.json"}')
        return
    dates, table = pd.aligned(daily.load(sorted(daily.datasets.UNIVERSE)))
    report = {'horizonSessions': HORIZON, 'headlines': len(headlines), 'drivers': study(headlines, links, table, dates),
              'note': 'Direction-free relevance test of reviewed links; a link that carries information still says nothing about direction.'}
    batch.save(OUT / 'link-study.json', report)
    for driver, r in report['drivers'].items():
        print(f"  {driver:20s} events {r['events']:>4}  above/below typical move {r['aboveTypicalMove']}/{r['belowTypicalMove']}  {r['verdict']}")


if __name__ == '__main__':
    try:
        main()
    except ValueError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
