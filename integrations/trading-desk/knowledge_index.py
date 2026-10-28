"""Knowledge index (KNOW-06): everything the organisation has collected, stored in one place, connected and searchable.

The organisation's knowledge lives in many files: collected news, world stories, reviewed impact links and their study,
the news catalogue, market regimes, R&D results, method cards, the problem playbook and the scenario panel's calls. This
index rebuilds one local SQLite database from them every cycle (.local/knowledge/index.sqlite), with:
  nodes   share, source, driver, item (a collected news item), story, regime, idea, method, problem, call
  edges   item -names-> share (the fact-checker's own alias rules), item -mentions-> driver (the impact links' keywords),
          item -from-> source, story -groups-> item, story -names-> share, story -via-> driver,
          driver -may-affect-> share (INFERRED, carries the link study's verdict), call -on-> share, call -rehearses-> story
  search  full-text over titles and text (SQLite FTS5)
Retrieval is POINT-IN-TIME: `dossier(share, as_of)` returns only what was known by then (items published, stories
seen, regimes and calls dated at or before it), so an agent replaying a past day never sees the future.
Collected press is UNVERIFIED: the dossier says so, and nothing in it can be cited as evidence (only fact-checked,
reviewed evidence can). Nothing here fetches anything; a rebuild is deterministic from the files.
  .local\\replay-venv\\Scripts\\python.exe integrations\\trading-desk\\knowledge_index.py build
  .local\\replay-venv\\Scripts\\python.exe integrations\\trading-desk\\knowledge_index.py search "repo rate"
  .local\\replay-venv\\Scripts\\python.exe integrations\\trading-desk\\knowledge_index.py about HDFCBANK [--as-of 2026-10-19T10:30:00Z]
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'claims'))
import batch  # noqa: E402
import chains  # noqa: E402
import claims  # noqa: E402
import daily  # noqa: E402

ROOT = daily.ROOT
DB = ROOT / '.local' / 'knowledge' / 'index.sqlite'
HERE = Path(__file__).resolve().parent
SESSION_CLOSE = 'T10:30:00Z'  # a day-stamped record (regime, panel call) is known after that day's 16:00 IST cycle


def _id(*parts):
    return hashlib.sha256('|'.join(map(str, parts)).encode()).hexdigest()[:16]


def _utc(value):
    """An ISO instant as UTC 'YYYY-MM-DDTHH:MM:SSZ' (so text order is time order), or None."""
    try:
        moment = datetime.fromisoformat(str(value))
    except ValueError:
        return None
    if moment.tzinfo is None:
        return None
    return moment.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def _read(path):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None


class Builder:
    def __init__(self, con):
        self.con, self.nodes, self.edges = con, 0, 0

    def node(self, node_id, kind, title, body='', at=None, **attrs):
        self.con.execute('INSERT OR REPLACE INTO nodes VALUES (?,?,?,?,?,?)', (node_id, kind, title[:300], body[:4000], at, json.dumps(attrs, sort_keys=True)))
        self.con.execute('INSERT INTO fts(id, kind, title, body) VALUES (?,?,?,?)', (node_id, kind, title[:300], body[:4000]))
        self.nodes += 1

    def edge(self, src, rel, dst, inferred=False, at=None):
        if self.con.execute('INSERT OR IGNORE INTO edges VALUES (?,?,?,?,?)', (src, rel, dst, int(inferred), at)).rowcount:
            self.edges += 1


def build(root=ROOT, out=DB):
    """Rebuilds the index from the organisation's files into a temporary file, then replaces the old one at once."""
    root, out = Path(root), Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix('.building')
    if tmp.exists():
        tmp.unlink()
    con = sqlite3.connect(tmp)
    con.executescript("""
      CREATE TABLE nodes (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT, at TEXT, attrs TEXT NOT NULL);
      CREATE TABLE edges (src TEXT NOT NULL, rel TEXT NOT NULL, dst TEXT NOT NULL, inferred INTEGER NOT NULL, at TEXT, PRIMARY KEY (src, rel, dst));
      CREATE INDEX edges_dst ON edges (dst, rel);
      CREATE INDEX nodes_kind_at ON nodes (kind, at);
      CREATE VIRTUAL TABLE fts USING fts5(id UNINDEXED, kind UNINDEXED, title, body, tokenize='porter');
    """)
    b = Builder(con)
    local = root / '.local'
    # shares
    for symbol, name in sorted(daily.datasets.UNIVERSE.items()):
        b.node('share:' + symbol.removesuffix('.NS'), 'share', name, f'{name} ({symbol.removesuffix(".NS")}, NSE)', symbol=symbol)
    # sources (the world catalogue: country and tier)
    catalogue = (_read(HERE.parents[0] / 'publisher-feeds' / 'world-sources.json') or {}).get('sources', [])
    for s in catalogue:
        b.node('source:' + s['sourceId'], 'source', s['name'], ', '.join(s.get('topics', [])), country=s['country'], tier=s['tier'])
    # drivers and their reviewed, inferred links, with the link study's verdict
    study = (_read(local / 'trading-desk' / 'chains' / 'link-study.json') or {}).get('drivers', {})
    links = chains.load_links()
    for link in links:
        verdict = study.get(link['driver'], {}).get('verdict', 'not-studied')
        b.node('driver:' + link['driver'], 'driver', link['driver'], link['basis'] + ' Keywords: ' + ', '.join(link['keywords']),
               region=link.get('region', 'IN'), keywords=link['keywords'], verdict=verdict)
        for symbol in link['symbols']:
            b.edge('driver:' + link['driver'], 'may-affect', 'share:' + symbol.removesuffix('.NS'), inferred=True)
    # collected news items (unverified press), one per link, from every feed run
    by_url = {}
    feeds = local / 'feeds'
    for selection in sorted(feeds.glob('*/runs/*/selection.json')) if feeds.exists() else []:
        for o in (_read(selection) or {}).get('observations', []):
            if o.get('url') and o['url'] not in by_url:
                by_url[o['url']] = o
    for url, o in sorted(by_url.items()):
        item = 'item:' + _id(url)
        text = f"{o.get('title', '')}\n{o.get('content', '')}"
        at = _utc(o.get('publishedAt'))
        b.node(item, 'item', o.get('title', ''), o.get('content', ''), at, url=url, sourceId=o.get('sourceId'), verified=False)
        if o.get('sourceId'):
            b.edge(item, 'from', 'source:' + o['sourceId'], at=at)
        for symbol in sorted(claims.mentions(text)):
            b.edge(item, 'names', 'share:' + symbol.removesuffix('.NS'), at=at)
        lower = text.lower()
        for link in links:
            if chains.matches(lower, link['keywords']):
                b.edge(item, 'mentions', 'driver:' + link['driver'], at=at)
    # world stories (every day's grouping), linked to their items by link
    url_item = {url: 'item:' + _id(url) for url in by_url}
    for path in sorted((local / 'world').glob('stories-*.json')) if (local / 'world').exists() else []:
        for s in (_read(path) or {}).get('top', []):
            story = 'story:' + _id(s['title'], s['firstSeen'])
            at = _utc(s.get('firstSeen'))
            b.node(story, 'story', s['title'], ' / '.join(s.get('sources', [])), at, countries=s.get('countries', []),
                   publishers=s.get('publishers'), crossBorder=s.get('crossBorder', False))
            for url in s.get('links', []):
                if url in url_item:
                    b.edge(story, 'groups', url_item[url], at=at)
            for symbol in s.get('directShares', []):
                b.edge(story, 'names', 'share:' + symbol, at=at)
            for d in s.get('drivers', []):
                b.edge(story, 'via', 'driver:' + d['driver'], inferred=True, at=at)
    # market regimes, one per day: the full history from the regime study, then each day's own file (which wins)
    regime_dir = local / 'trading-desk' / 'regime'
    days = {r['date']: r for r in (_read(regime_dir / 'history.json') or {}).get('days', []) if r.get('date')}
    for path in sorted(regime_dir.glob('regime-*.json')) if regime_dir.exists() else []:
        r = _read(path)
        if r and r.get('date'):
            days[r['date']] = r
    for r in days.values():
        b.node('regime:' + r['date'], 'regime', f"{r['risk']} regime", f"{r['distributionDays']} distribution days; "
               f"{r.get('breadth200d')}/{r.get('shares')} shares above their 200-day average", r['date'] + SESSION_CLOSE,
               risk=r['risk'], exposureCeilingPct=r.get('exposureCeilingPct'), inputsComplete=r.get('inputsComplete'))
    # R&D ideas (the latest screen of each universe)
    rnd = local / 'trading-desk' / 'rnd'
    for universe, pattern in (('desk', 'scout-[0-9][0-9][0-9][0-9]-[0-9][0-9].json'), ('nifty50', 'scout-nifty50-*.json')):
        files = sorted(rnd.glob(pattern)) if rnd.exists() else []
        report = _read(files[-1]) if files else None
        for c in (report or {}).get('candidates', []):
            b.node(f"idea:{universe}:{c['name']}", 'idea', c['name'], c.get('description', ''), None, universe=universe,
                   through=report['through'], ahead=c['ahead'], behind=c['behind'], averageExcessPct=c['averageExcessPct'],
                   pValue=c['pValue'], passes=c['passes'], afterTaxCagrPct=(c.get('proof') or {}).get('afterTaxCagrPct'))
    # method cards and the problem playbook
    for c in (_read(HERE / 'knowledge' / 'methods.json') or {}).get('cards', []):
        b.node('method:' + c['id'], 'method', c['id'], f"{c['idea']} Result: {c['result']} Lesson: {c['lesson']}", None, source=c['source'])
    for p in (_read(HERE / 'knowledge' / 'problems.json') or {}).get('problems', []):
        b.node('problem:' + p['id'], 'problem', p['id'], f"{p['cause']} Fix: {p['fix']}", None, decidedBy=p['decidedBy'])
    # the scenario panel's calls, linked to their share and to the story they rehearsed
    story_by_title = {}
    for row in con.execute("SELECT id, title FROM nodes WHERE kind='story' ORDER BY at"):
        story_by_title.setdefault(row[1], row[0])
    calls = local / 'trading-desk' / 'scenario' / 'calls.jsonl'
    if calls.exists():
        for line in calls.read_text(encoding='utf-8').splitlines():
            try:
                c = json.loads(line)
            except ValueError:
                continue
            call = 'call:scenario:' + _id(c['day'], c['symbol'], c['story'])
            at = c['day'] + SESSION_CLOSE
            b.node(call, 'call', f"panel: {c['direction']} {c['symbol']}", c['story'], at, votes=c.get('votes'), failedVoices=c.get('failedVoices', 0))
            b.edge(call, 'on', 'share:' + c['symbol'].removesuffix('.NS'), at=at)
            if c['story'] in story_by_title:
                b.edge(call, 'rehearses', story_by_title[c['story']], at=at)
    con.execute('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
    stats = {kind: n for kind, n in con.execute('SELECT kind, COUNT(*) FROM nodes GROUP BY kind ORDER BY kind')}
    meta = {'builtAt': datetime.now(timezone.utc).isoformat(), 'nodes': b.nodes, 'edges': b.edges, 'byKind': stats}
    con.execute("INSERT INTO meta VALUES ('build', ?)", (json.dumps(meta),))
    con.commit()
    con.close()
    batch.replace(tmp, out)  # a reader (status, the debate) may hold the old index open for a moment
    (out.parent / 'index-meta.json').write_text(json.dumps(meta, indent=2), encoding='utf-8')  # for readers without SQLite (status)
    return meta


def _connect(db=DB):
    if not Path(db).exists():
        raise ValueError('No knowledge index yet: run knowledge_index.py build')
    con = sqlite3.connect(f'file:{Path(db).as_posix()}?mode=ro', uri=True)
    con.row_factory = sqlite3.Row
    return con


def search(query, kinds=None, limit=10, db=DB, as_of=None):
    """Full-text search; every word must appear (quoted, so punctuation is never query syntax). Newest first."""
    words = [w for w in re.findall(r'[\w&+-]+', query) if w]
    if not words:
        return []
    match = ' AND '.join('"' + w.replace('"', '') + '"' for w in words)
    con = _connect(db)
    try:
        rows = con.execute(f"""SELECT n.id, n.kind, n.title, n.at, snippet(fts, 3, '[', ']', '...', 12) AS snippet
            FROM fts JOIN nodes n ON n.id = fts.id WHERE fts MATCH ? {'AND n.kind IN (' + ','.join('?' * len(kinds)) + ')' if kinds else ''}
            {'AND (n.at IS NULL OR n.at <= ?)' if as_of else ''} ORDER BY n.at DESC NULLS LAST LIMIT ?""",
                           [match, *(kinds or []), *([_utc(as_of)] if as_of else []), limit]).fetchall()
        return [dict(r) for r in rows]
    finally:
        con.close()


def dossier(symbol, as_of=None, db=DB, direct=8, inferred=5, stories=5, calls=5):
    """What the organisation knew about one share by `as_of` (default: everything): items naming it, items reaching it
    through a driver (inferred, with the driver and its study verdict), stories, the latest regime and panel calls.
    Bounded, labelled unverified, and point-in-time."""
    symbol = symbol.upper().removesuffix('.NS')
    cut = _utc(as_of) if as_of else '9999-12-31T23:59:59Z'
    con = _connect(db)
    try:
        share = con.execute('SELECT title FROM nodes WHERE id=?', ('share:' + symbol,)).fetchone()
        if not share:
            raise ValueError(f'Unknown share {symbol}')
        named = con.execute("""SELECT n.title, n.at, json_extract(n.attrs, '$.sourceId') AS source FROM edges e JOIN nodes n ON n.id = e.src
            WHERE e.dst = ? AND e.rel = 'names' AND n.kind = 'item' AND n.at <= ? ORDER BY n.at DESC LIMIT ?""", ('share:' + symbol, cut, direct)).fetchall()
        drivers = con.execute("""SELECT d.id, d.title, json_extract(d.attrs, '$.verdict') AS verdict, json_extract(d.attrs, '$.region') AS region
            FROM edges e JOIN nodes d ON d.id = e.src WHERE e.dst = ? AND e.rel = 'may-affect' ORDER BY d.title""", ('share:' + symbol,)).fetchall()
        reach = con.execute(f"""SELECT n.title, n.at, d.title AS driver, json_extract(d.attrs, '$.verdict') AS verdict FROM edges m
            JOIN nodes n ON n.id = m.src JOIN nodes d ON d.id = m.dst
            WHERE m.rel = 'mentions' AND m.dst IN ({','.join('?' * len(drivers)) or "''"}) AND n.at <= ?
              AND NOT EXISTS (SELECT 1 FROM edges x WHERE x.src = n.id AND x.rel = 'names' AND x.dst = ?)
            ORDER BY n.at DESC LIMIT ?""", [*(d['id'] for d in drivers), cut, 'share:' + symbol, inferred * 4]).fetchall()
        merged = {}
        for r in reach:  # one item reaching the share through several drivers is one entry listing them all
            entry = merged.setdefault((r['title'], r['at']), {'title': r['title'], 'publishedAt': r['at'], 'drivers': []})
            entry['drivers'].append({'driver': r['driver'], 'linkVerdict': r['verdict']})
        reach = list(merged.values())[:inferred]
        story_rows = con.execute(f"""SELECT DISTINCT s.title, s.at, json_extract(s.attrs, '$.countries') AS countries FROM edges e JOIN nodes s ON s.id = e.src
            WHERE s.kind = 'story' AND s.at <= ? AND ((e.rel = 'names' AND e.dst = ?) OR (e.rel = 'via' AND e.dst IN ({','.join('?' * len(drivers)) or "''"})))
            ORDER BY s.at DESC LIMIT ?""", [cut, 'share:' + symbol, *(d['id'] for d in drivers), stories]).fetchall()
        regime = con.execute("SELECT title, at, json_extract(attrs, '$.inputsComplete') AS complete FROM nodes WHERE kind='regime' AND at <= ? ORDER BY at DESC LIMIT 1", (cut,)).fetchone()
        panel = con.execute("""SELECT n.title, n.at FROM edges e JOIN nodes n ON n.id = e.src WHERE e.dst = ? AND e.rel = 'on' AND n.kind = 'call' AND n.at <= ?
            ORDER BY n.at DESC LIMIT ?""", ('share:' + symbol, cut, calls)).fetchall()
        return {'share': {'symbol': symbol, 'name': share['title']}, 'asOf': as_of, 'unverified': True,
                'namedInPress': [{'title': r['title'], 'publishedAt': r['at'], 'source': r['source']} for r in named],
                'reachedThroughDrivers': reach,
                'drivers': [{'driver': d['title'], 'region': d['region'], 'linkVerdict': d['verdict']} for d in drivers],
                'stories': [{'title': r['title'], 'firstSeen': r['at'], 'countries': json.loads(r['countries'] or '[]')} for r in story_rows],
                'regime': {'state': regime['title'], 'asOf': regime['at'][:10], 'inputsComplete': regime['complete']} if regime else None,
                'panelCalls': [{'call': r['title'], 'day': r['at'][:10]} for r in panel],
                'note': 'Collected press and inferred links: background, never evidence. Only fact-checked, reviewed evidence can be cited.'}
    finally:
        con.close()


def stats(db=DB):
    con = _connect(db)
    try:
        return json.loads(con.execute("SELECT value FROM meta WHERE key='build'").fetchone()[0])
    finally:
        con.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('build')
    sub.add_parser('stats')
    s = sub.add_parser('search')
    s.add_argument('query')
    s.add_argument('--kind', action='append')
    s.add_argument('--limit', type=int, default=10)
    a = sub.add_parser('about')
    a.add_argument('symbol')
    a.add_argument('--as-of')
    args = parser.parse_args(argv)
    if args.command == 'build':
        m = build()
        print(json.dumps({'state': 'done', 'nodes': m['nodes'], 'edges': m['edges'], 'byKind': m['byKind']}))
    elif args.command == 'stats':
        print(json.dumps(stats(), indent=2))
    elif args.command == 'search':
        for r in search(args.query, args.kind, args.limit):
            print(f"{(r['at'] or '')[:16]:16s} {r['kind']:8s} {r['title'][:90]}\n{'':26s}{r['snippet'][:140]}")
    else:
        print(json.dumps(dossier(args.symbol, args.as_of), indent=2, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except ValueError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
