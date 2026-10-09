"""Builds a self-contained results page from the desk's saved outputs. Read-only on results.

Shows the batch results, each bot's fitness verdict, the walk-forward test, the automatic knowledge pipelines
(news claims and desk results), Kronos forecast evaluations and live paper books, each only once it exists.
"""
import argparse
from datetime import datetime, timezone
import html
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fitness  # noqa: E402
import walkforward  # noqa: E402

BATCHES = walkforward.BATCHES
DESK_LOCAL = BATCHES.parent
OUT = DESK_LOCAL / 'dashboard.html'
CLAIMS_STATE = walkforward.desk.ROOT / '.local' / 'claims' / 'auto'


def read_json(path, default):
    try:
        return json.loads(path.read_text(encoding='utf-8')) if path.exists() else default
    except (OSError, ValueError):
        return default


def tally(values):
    out = {}
    for v in values:
        out[v] = out.get(v, 0) + 1
    return out


def knowledge_status(claims_state=None, desk_state=None):
    """What the two automatic learning pipelines have done, from their own decision records."""
    claims_state = claims_state or CLAIMS_STATE
    desk_state = desk_state or DESK_LOCAL / 'auto-learning'
    news = None
    if (claims_state / 'decisions.json').exists():
        decisions = read_json(claims_state / 'decisions.json', {})
        cycles = (claims_state / 'cycles.jsonl').read_text(encoding='utf-8').splitlines() if (claims_state / 'cycles.jsonl').exists() else []
        news = {'reasons': tally(d['reason'] for d in decisions.values()),
                'verified': sum(d['decision'] == 'verified' and d.get('sent', False) for d in decisions.values()),
                'rejected': sum(d['decision'] == 'rejected' and d.get('sent', False) for d in decisions.values()),
                'waiting': sum(d['decision'] == 'hold' for d in decisions.values()),
                'lessons': sum(r['status'] == 'verified' for r in read_json(claims_state / 'lesson-reviews.json', {}).values()),
                'revoked': len(read_json(claims_state / 'revocations.json', {})),
                'headlines': len(read_json(claims_state / 'verified-headlines.json', [])),
                'cycles': len(cycles), 'lastCycle': json.loads(cycles[-1]).get('at') if cycles else None}
    results = None
    if (desk_state / 'evidence-reviews.json').exists():
        reviews = read_json(desk_state / 'evidence-reviews.json', {})
        results = {'weeks': tally(r['status'] for r in reviews.values()),
                   'lessons': sum(r['status'] == 'verified' for r in read_json(desk_state / 'lesson-reviews.json', {}).values()),
                   'revoked': len(read_json(desk_state / 'revocations.json', {}))}
    return {'news': news, 'results': results}


def forecast_status(directory=None):
    """The newest Kronos evaluation report, if any."""
    directory = directory or DESK_LOCAL / 'forecast-reports'
    reports = sorted(directory.glob('*.json'), key=lambda p: p.stat().st_mtime) if directory.exists() else []
    if not reports:
        return None
    report = read_json(reports[-1], None)
    if not report:
        return None
    return {'name': reports[-1].stem, 'weeks': report.get('weeks'), 'start': report.get('start'), 'arms': report.get('arms', {}),
            'buyAndHoldPaise': report.get('buyAndHoldPaise')}


def live_status(directory=None):
    """One row per live paper book."""
    directory = directory or DESK_LOCAL / 'live'
    rows = []
    for path in sorted(directory.glob('*/state.json')) if directory.exists() else []:
        s = read_json(path, None)
        if not s:
            continue
        book = walkforward.desk.Book(s['book']).result()
        rows.append({'book': path.parent.name, 'symbol': s['symbol'], 'lastBar': s['lastBar'], 'netPaise': book['netPaise'],
                     'trades': len(book['trades']), 'open': book['openPosition'] is not None,
                     'meetings': sum(s['meetingsByDay'].values()), 'model': s['model']})
    return rows


def collect(control, treated):
    rows = walkforward.load_rows(BATCHES / control)
    weeks = []
    for r in rows:
        s = r['scorecards']
        m = s.get('portfolioManager', {})
        weeks.append({'label': datetime.fromisoformat(r['from']).strftime('%d %b'), 'from': r['from'][:10], 'to': r['to'][:10],
                      'desk': r['deskNetPaise'] / 100, 'momentum': r['momentumNetPaise'] / 100, 'hold': r['buyAndHoldPaise'] / 100,
                      'deskTrades': r['deskTrades'], 'momentumTrades': r['momentumTrades'],
                      'managerCorrect': m.get('correct', 0), 'managerDecisions': m.get('decisions', 0),
                      'holdCorrect': m.get('alwaysHoldCorrect', 0), 'actions': m.get('actions', {}),
                      'trendHits': s['analysts']['trend-analyst']['correct'], 'trendN': s['analysts']['trend-analyst']['opinions'],
                      'revHits': s['analysts']['reversion-analyst']['correct'], 'revN': s['analysts']['reversion-analyst']['opinions'],
                      'vetoes': s['riskOfficer']['vetoedEntries'], 'key': r['datasetKey']})
    meetings = []
    blocked = 0
    for r in rows:
        decisions = json.loads((BATCHES / control / f"{r['datasetKey']}.decisions.json").read_text(encoding='utf-8'))
        blocked += sum(1 for d in decisions if d.get('type') == 'desk-meeting' and 'portfolio-manager' not in d['bots'])
    if rows:
        latest = rows[-1]
        for d in json.loads((BATCHES / control / f"{latest['datasetKey']}.decisions.json").read_text(encoding='utf-8')):
            when = d['bar'][5:16].replace('T', ' ')
            if d['type'] != 'desk-meeting':
                meetings.append({'when': when, 'kind': d['type'], 'action': d['action']})
                continue
            b = d['bots']
            if 'portfolio-manager' not in b:
                meetings.append({'when': when, 'kind': 'blocked', 'action': 'hold', 'note': ', '.join(b['data-steward']['reasons'])})
                continue
            op = lambda role: b[role].get('opinion', {})  # noqa: E731
            meetings.append({'when': when, 'kind': 'meeting', 'trend': f"{op('trend-analyst').get('stance')} · {op('trend-analyst').get('conviction')}",
                             'reversion': f"{op('reversion-analyst').get('stance')} · {op('reversion-analyst').get('conviction')}",
                             'proposed': b['portfolio-manager'].get('decision', {}).get('action'), 'action': d['action'],
                             'vetoes': b.get('risk-officer', {}).get('vetoes', []),
                             'note': b['portfolio-manager'].get('decision', {}).get('rationale', '')})
    summary = {}
    path = BATCHES / control / 'summary.json'
    if path.exists():
        summary = json.loads(path.read_text(encoding='utf-8'))
    comparison = None
    if (BATCHES / treated / 'comparison.json').exists():
        comparison = json.loads((BATCHES / treated / 'comparison.json').read_text(encoding='utf-8'))
        comparison.pop('lessons', None)
    return {'weeks': weeks, 'meetings': meetings, 'blocked': blocked, 'planned': summary.get('windowsPlanned', 8),
            'model': rows[0]['model'] if rows else None, 'every': rows[0]['every'] if rows else None,
            'latestWeek': f"{rows[-1]['from'][:10]} to {rows[-1]['to'][:10]}" if rows else None,
            'walkforward': comparison, 'fitness': fitness.evaluate(fitness.load([control], batches=BATCHES)) if rows else None,
            'knowledge': knowledge_status(), 'forecast': forecast_status(), 'live': live_status(),
            'generatedAt': datetime.now(timezone.utc).strftime('%d %b %Y, %H:%M UTC')}


def render(data):
    payload = json.dumps(data).replace('</', '<\\/')
    return TEMPLATE.replace('__DATA__', payload).replace('__GENERATED__', html.escape(data['generatedAt']))


TEMPLATE = r'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>RELIANCE Desk Ledger</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@600;700;800&family=Source+Sans+3:wght@400;600&family=JetBrains+Mono:wght@400;600&display=swap">
<style>
/* Layout: a single reading column; summary figures, then the weekly chart, then each bot's record. */
:root {
  --bg: #f6f7f9; --surface: #fdfdfc; --ink: #10141a; --ink-2: #4b5260; --muted: #858b96;
  --line: #e3e5ea; --base: #c4c8d0; --accent: #2a78d6;
  --desk: #2a78d6; --momentum: #eb6834; --hold: #1baf7a;
  --good: #0ca30c; --warn: #b07800; --bad: #d03b3b; --chip: #eef0f4;
  --display: "Archivo", "Arial Narrow", Arial, sans-serif;
  --body: "Source Sans 3", "Segoe UI", system-ui, sans-serif;
  --mono: "JetBrains Mono", Consolas, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #0e1013; --surface: #171a1f; --ink: #f2f4f7; --ink-2: #b7bdc8; --muted: #8a909b;
  --line: #262a31; --base: #3a3f48; --accent: #3987e5;
  --desk: #3987e5; --momentum: #d95926; --hold: #199e70;
  --good: #0ca30c; --warn: #fab219; --bad: #e66767; --chip: #222630; color-scheme: dark; } }
:root[data-theme="dark"] {
  --bg: #0e1013; --surface: #171a1f; --ink: #f2f4f7; --ink-2: #b7bdc8; --muted: #8a909b;
  --line: #262a31; --base: #3a3f48; --accent: #3987e5;
  --desk: #3987e5; --momentum: #d95926; --hold: #199e70;
  --good: #0ca30c; --warn: #fab219; --bad: #e66767; --chip: #222630; color-scheme: dark; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.55 var(--body); }
.wrap { max-width: 980px; margin: 0 auto; padding-inline: 16px; padding-block: 28px 56px; display: grid; gap: 34px; }
h1, h2 { font-family: var(--display); text-wrap: balance; margin: 0; letter-spacing: -0.01em; }
h1 { font-size: clamp(1.9rem, 4vw, 2.6rem); font-weight: 800; }
h2 { font-size: 1.3rem; font-weight: 700; }
p { margin: 0; max-width: 65ch; color: var(--ink-2); }
.eyebrow { font: 600 0.74rem/1 var(--mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
header { display: grid; gap: 10px; }
.meta { display: flex; flex-wrap: wrap; gap: 8px 18px; font: 0.82rem var(--mono); color: var(--muted); }
.totals { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; }
.total { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; display: grid; gap: 4px; }
.total .who { display: flex; align-items: center; gap: 8px; font-weight: 600; color: var(--ink-2); font-size: 0.92rem; }
.swatch { width: 10px; height: 10px; border-radius: 3px; flex: none; }
.total .num { font: 600 1.7rem/1.1 var(--mono); font-variant-numeric: tabular-nums; }
.total .sub { font-size: 0.84rem; color: var(--muted); }
section { display: grid; gap: 14px; min-width: 0; }
.panel { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 16px; min-width: 0; }
.legend { display: flex; flex-wrap: wrap; gap: 14px; font-size: 0.88rem; color: var(--ink-2); }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.chart { position: relative; }
.chart svg { display: block; width: 100%; height: auto; overflow: visible; }
.tip { position: absolute; pointer-events: none; background: var(--ink); color: var(--bg); font: 0.8rem/1.4 var(--mono);
  padding: 6px 9px; border-radius: 6px; white-space: nowrap; transform: translate(-50%, -110%); }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font: 600 0.72rem var(--mono); text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
td.n { font-family: var(--mono); font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
.bots { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
.bot { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; display: grid; gap: 8px; align-content: start; }
.bot h3 { margin: 0; font: 700 1.02rem var(--display); }
.kind { font: 0.72rem var(--mono); color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
.metric { font: 600 1.25rem var(--mono); font-variant-numeric: tabular-nums; }
.chip { justify-self: start; display: inline-flex; align-items: center; gap: 6px; font-size: 0.8rem; font-weight: 600;
  padding: 3px 9px; border-radius: 999px; background: var(--chip); }
.chip::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
.chip.good { color: var(--good); } .chip.warn { color: var(--warn); } .chip.bad { color: var(--bad); }
.pending { border: 1px dashed var(--base); border-radius: 12px; padding: 18px; display: grid; gap: 6px; }
.act { font-family: var(--mono); font-weight: 600; }
.act.buy { color: var(--good); } .act.sell { color: var(--bad); }
.note { color: var(--ink-2); font-size: 0.85rem; max-width: 46ch; }
footer p { font-size: 0.85rem; }
@media (prefers-reduced-motion: no-preference) { .bar { transition: opacity .15s; } }
</style>
</head>
<body>

<div class="wrap">
  <header>
    <span class="eyebrow">AI trading desk · paper replay</span>
    <h1>RELIANCE Desk Ledger</h1>
    <p id="lede"></p>
    <div class="meta" id="meta"></div>
  </header>

  <section aria-labelledby="totals-h">
    <h2 id="totals-h">Totals after costs</h2>
    <div class="totals" id="totals"></div>
  </section>

  <section aria-labelledby="weekly-h">
    <h2 id="weekly-h">Week by week</h2>
    <p>Net result per week in rupees for one share, after 5 bps slippage and 10 bps fees on each side. Bars above the line made money.</p>
    <div class="panel">
      <div class="legend" id="legend"></div>
      <div class="chart" id="chart"><div class="tip" id="tip" hidden></div></div>
    </div>
    <div class="panel scroll"><table id="weekly-table"></table></div>
  </section>

  <section aria-labelledby="bots-h">
    <h2 id="bots-h">Each bot's record</h2>
    <p>Every bot is judged on its own job against the do-nothing version of it: analysts against always saying "neutral", the manager against never trading. Only meetings where they disagree count, and a sign test asks whether the wins could be luck.</p>
    <div class="bots" id="bots"></div>
  </section>

  <section aria-labelledby="learn-h">
    <h2 id="learn-h">Learning from experience</h2>
    <div id="learning"></div>
  </section>

  <section aria-labelledby="know-h">
    <h2 id="know-h">Automatic knowledge</h2>
    <p>Two pipelines teach the bots with no human step. In each, an analyst bot proposes and an independent fact-checker bot, with no model, verifies by fixed rules and revokes what later proves wrong.</p>
    <div class="bots" id="knowledge"></div>
  </section>

  <section aria-labelledby="fc-h">
    <h2 id="fc-h">Forecast analyst (Kronos)</h2>
    <div id="forecast"></div>
  </section>

  <section aria-labelledby="live-h">
    <h2 id="live-h">Live paper books</h2>
    <div id="live"></div>
  </section>

  <section aria-labelledby="log-h">
    <h2 id="log-h">Latest week's meetings</h2>
    <p id="log-lede"></p>
    <div class="panel scroll"><table id="log"></table></div>
  </section>

  <footer><p>Generated __GENERATED__ from saved desk results. Paper replay on historical Yahoo data: no orders, wallets or trading authority. A few weeks of one stock cannot establish skill.</p></footer>
</div>

<script>
const D = __DATA__;
const rs = v => (v < 0 ? '−₹' : '₹') + Math.abs(v).toFixed(2);
const pct = (a, b) => b ? Math.round(100 * a / b) + '%' : '—';
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const SERIES = [['desk', 'AI trading desk', 'var(--desk)'], ['momentum', 'Momentum rule', 'var(--momentum)'], ['hold', 'Buy and hold', 'var(--hold)']];
const sum = k => D.weeks.reduce((s, w) => s + w[k], 0);

document.getElementById('lede').textContent = D.weeks.length
  ? `The bots meet every ${D.every * 5} minutes on 5-minute bars: rule-based guards and AI roles using ${D.model}. ${D.weeks.length} of ${D.planned} weeks are complete.`
  : 'No completed weeks yet.';
document.getElementById('meta').innerHTML = D.weeks.length
  ? `<span>${esc(D.weeks[0].from)} → ${esc(D.weeks[D.weeks.length - 1].to)}</span><span>${D.weeks.length}/${D.planned} weeks</span><span>model ${esc(D.model)}</span>` : '';

const trades = {desk: sum('deskTrades'), momentum: sum('momentumTrades')};
document.getElementById('totals').innerHTML = SERIES.map(([k, name, color]) => `
  <div class="total"><div class="who"><span class="swatch" style="background:${color}"></span>${name}</div>
  <div class="num">${rs(sum(k))}</div>
  <div class="sub">${k === 'hold' ? 'one share, held all week' : trades[k] + ' fills'}</div></div>`).join('');

document.getElementById('legend').innerHTML = SERIES.map(([, name, color]) => `<span><span class="swatch" style="background:${color}"></span>${name}</span>`).join('');

(function chart() {
  const host = document.getElementById('chart'), tip = document.getElementById('tip');
  const W = 900, H = 300, L = 62, R = 12, T = 14, B = 34;
  const vals = D.weeks.flatMap(w => SERIES.map(([k]) => w[k]));
  let lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  const step = (() => { const span = (hi - lo) || 10, raw = span / 5, p = 10 ** Math.floor(Math.log10(raw)); return [1, 2, 5, 10].map(m => m * p).find(s => s >= raw); })();
  lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  const y = v => T + (hi - v) / (hi - lo) * (H - T - B);
  const band = (W - L - R) / Math.max(D.weeks.length, 1), bw = Math.min(26, (band - 18) / 3);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Weekly net result by strategy">`;
  for (let v = lo; v <= hi + 1e-9; v += step) {
    s += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${v === 0 ? 'var(--base)' : 'var(--line)'}" stroke-width="${v === 0 ? 1.5 : 1}"/>`;
    s += `<text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" font-size="12" fill="var(--muted)" font-family="JetBrains Mono, monospace">${rs(v).replace('.00', '')}</text>`;
  }
  D.weeks.forEach((w, i) => {
    const cx = L + band * i + band / 2;
    SERIES.forEach(([k, name, color], j) => {
      const x = cx + (j - 1) * (bw + 2) - bw / 2, v = w[k], top = Math.min(y(v), y(0)), h = Math.max(Math.abs(y(v) - y(0)), 1.5);
      s += `<rect class="bar" x="${x}" y="${top}" width="${bw}" height="${h}" rx="3" fill="${color}" data-tip="${esc(w.label)} · ${name}: ${rs(v)}"/>`;
    });
    s += `<text x="${cx}" y="${H - 10}" text-anchor="middle" font-size="12" fill="var(--muted)" font-family="Source Sans 3, sans-serif">${esc(w.label)}</text>`;
  });
  host.insertAdjacentHTML('afterbegin', s + '</svg>');
  host.querySelectorAll('.bar').forEach(bar => {
    bar.addEventListener('mousemove', e => { const r = host.getBoundingClientRect(); tip.hidden = false; tip.textContent = bar.dataset.tip; tip.style.left = (e.clientX - r.left) + 'px'; tip.style.top = (e.clientY - r.top) + 'px'; });
    bar.addEventListener('mouseleave', () => { tip.hidden = true; });
  });
})();

document.getElementById('weekly-table').innerHTML = `<thead><tr><th>Week</th><th>AI desk</th><th>Desk fills</th><th>Momentum</th><th>Buy and hold</th></tr></thead><tbody>${
  D.weeks.map(w => `<tr><td>${esc(w.from)} → ${esc(w.to)}</td><td class="n">${rs(w.desk)}</td><td class="n">${w.deskTrades}</td><td class="n">${rs(w.momentum)}</td><td class="n">${rs(w.hold)}</td></tr>`).join('')}</tbody>`;

(function bots() {
  const t = sum('trendHits'), tn = sum('trendN'), r = sum('revHits'), rn = sum('revN');
  const mc = sum('managerCorrect'), md = sum('managerDecisions'), hc = sum('holdCorrect');
  const acts = D.weeks.reduce((a, w) => { for (const [k, v] of Object.entries(w.actions)) a[k] = (a[k] || 0) + v; return a; }, {});
  const VERDICT = {'adds-value': ['good', 'Adds value'], 'worse-than-baseline': ['bad', 'Worse than doing nothing'],
    'no-detectable-skill': ['warn', 'No detectable skill'], 'insufficient-evidence': ['warn', 'Not enough evidence yet'],
    'no-valid-calls': ['bad', 'No valid calls'], 'not-consulted': ['warn', 'Not consulted']};
  const F = D.fitness || {};
  const judged = (role, fallback, baseName) => {
    const f = F[role];
    if (!f || !f.judged) return fallback;
    return [`${Math.round(100 * f.accuracy)}%`, `${f.correct} of ${f.judged} right; ${baseName} ${f.baselineCorrect}. Wins ${f.wins}, losses ${f.losses}${f.pValue != null ? ', p = ' + f.pValue : ''}.`, VERDICT[f.verdict]];
  };
  const cards = [
    ['Data steward', 'rule', `${D.blocked}`, 'meetings blocked for gaps or missing volume', ['good', 'Working']],
    ['Trend analyst', 'AI · momentum, volatility, volume', ...judged('trend-analyst', [pct(t, tn), `${t} of ${tn} calls right`, VERDICT['insufficient-evidence']], 'always neutral')],
    ['Reversion analyst', 'AI · VWAP, day range, gap', ...judged('reversion-analyst', [pct(r, rn), `${r} of ${rn} calls right`, VERDICT['insufficient-evidence']], 'always neutral')],
    ['Portfolio manager', 'AI · decides on analyst views', ...judged('portfolio-manager', [pct(mc, md), `right ${mc} of ${md}; never trading ${hc}`, VERDICT['insufficient-evidence']], 'never trading')],
    ['Risk officer', 'rule · veto and stop-loss', `${sum('vetoes')}`, `entries vetoed. Manager actions: ${Object.entries(acts).map(([k, v]) => k + ' ' + v).join(', ') || 'none'}`, ['good', 'Working']],
  ];
  for (const [role, name, kind] of [['forecast-analyst', 'Forecast analyst', 'model · Kronos forecast'], ['news-analyst', 'News analyst', 'AI · verified headlines']]) {
    if (F[role] && F[role].judged) cards.splice(3, 0, [name, kind, ...judged(role, null, 'always neutral')]);
  }
  document.getElementById('bots').innerHTML = cards.map(([name, kind, metric, desc, [cls, label]]) => `
    <div class="bot"><span class="kind">${esc(kind)}</span><h3>${name}</h3><div class="metric">${esc(metric)}</div>
    <p>${esc(desc)}</p><span class="chip ${cls}">${label}</span></div>`).join('');
})();

(function learning() {
  const box = document.getElementById('learning'), c = D.walkforward;
  if (!c) {
    box.innerHTML = `<div class="pending"><strong>Waiting for the control run</strong>
      <p>When all weeks finish, each bot receives plain facts about its own record from the oldest weeks, then the desk re-runs the newest weeks. Each test week is compared with its result without lessons.</p></div>`;
    return;
  }
  box.innerHTML = `<p>Lessons from ${esc(c.train.join(', '))}. ${c.windowsImproved} of ${c.testWindows} test weeks improved, ${c.windowsWorse} got worse. Net ${rs(c.netPaise.withoutLessons / 100)} without lessons, ${rs(c.netPaise.withLessons / 100)} with lessons.</p>
    <div class="panel scroll"><table><thead><tr><th>Test week</th><th>Without lessons</th><th>With lessons</th><th>Manager right (without → with)</th><th>Never trading</th></tr></thead><tbody>${
    c.pairs.map(p => `<tr><td>${esc(p.from)} → ${esc(p.to)}</td><td class="n">${rs(p.netPaise.withoutLessons / 100)}</td><td class="n">${rs(p.netPaise.withLessons / 100)}</td>
      <td class="n">${p.managerAccuracy.withoutLessons ?? '—'} → ${p.managerAccuracy.withLessons ?? '—'}</td><td class="n">${p.managerAccuracy.alwaysHold ?? '—'}</td></tr>`).join('')}</tbody></table></div>`;
})();

(function knowledge() {
  const k = D.knowledge || {}, box = document.getElementById('knowledge');
  const card = (name, kind, metric, desc, chip) => `<div class="bot"><span class="kind">${esc(kind)}</span><h3>${esc(name)}</h3>
    <div class="metric">${esc(metric)}</div><p>${esc(desc)}</p><span class="chip ${chip[0]}">${esc(chip[1])}</span></div>`;
  const n = k.news, r = k.results;
  box.innerHTML = [
    n ? card('News → verified knowledge', 'claim analyst + fact-checker', `${n.lessons} lessons`,
          `${n.verified} articles verified, ${n.rejected} rejected, ${n.waiting} waiting for corroboration, ${n.revoked} revoked later. ${n.headlines} verified headlines feed the news analyst. ${n.cycles} cycles${n.lastCycle ? ', last ' + n.lastCycle.slice(0, 16).replace('T', ' ') + ' UTC' : ''}.`,
          n.revoked ? ['warn', 'Running · revocations recorded'] : ['good', 'Running'])
      : card('News → verified knowledge', 'claim analyst + fact-checker', '—', 'Not started. It needs an approved news source, the backend running and one evaluator credential.', ['warn', 'Not started']),
    r ? card('Desk results → verified lessons', 'desk analyst + desk fact-checker', `${r.lessons} lessons`,
          `Weeks: ${Object.entries(r.weeks).map(([s, c]) => c + ' ' + s).join(', ') || 'none'}. ${r.revoked} revoked. Every number is recomputed from the raw data before it is verified.`,
          r.weeks.rejected ? ['bad', 'A misreport was rejected'] : ['good', 'Running'])
      : card('Desk results → verified lessons', 'desk analyst + desk fact-checker', '—', 'Not started. It needs an approved source for desk results and organisation bots mapped to desk roles.', ['warn', 'Not started']),
  ].join('');
})();

(function forecast() {
  const f = D.forecast, box = document.getElementById('forecast');
  if (!f) {
    box.innerHTML = `<div class="pending"><strong>Not evaluated yet</strong><p>Kronos, the one trainable model among the reference repositories, is scored against always-neutral and a momentum rule on weeks it never trained on before it may join the desk. Setup needs PyTorch and the model weights.</p></div>`;
    return;
  }
  const rows = Object.entries(f.arms).map(([name, a]) => `<tr><td>${esc(name)}</td><td class="n">${a.stanceAccuracy ?? '—'}</td><td class="n">${a.pearson ?? '—'}</td><td class="n">${a.spearman ?? '—'}</td><td class="n">${rs(a.paperRuleNetPaise / 100)}</td><td class="n">${a.paperRuleTrades}</td></tr>`).join('');
  box.innerHTML = `<p>Report "${esc(f.name)}": ${f.weeks} weeks${f.start ? ' from ' + esc(f.start) : ''}. Buy and hold over the same weeks: ${rs(f.buyAndHoldPaise / 100)}.</p>
    <div class="panel scroll"><table><thead><tr><th>Forecaster</th><th>Stance accuracy</th><th>Pearson</th><th>Spearman</th><th>Paper rule net</th><th>Fills</th></tr></thead><tbody>${rows}</tbody></table></div>`;
})();

(function live() {
  const rows = D.live || [], box = document.getElementById('live');
  box.innerHTML = rows.length
    ? `<div class="panel scroll"><table><thead><tr><th>Book</th><th>Share</th><th>Last bar</th><th>Net</th><th>Fills</th><th>Meetings</th><th>Holding</th></tr></thead><tbody>${
      rows.map(b => `<tr><td>${esc(b.book)}</td><td>${esc(b.symbol)}</td><td class="n">${esc((b.lastBar || '—').slice(0, 16).replace('T', ' '))}</td><td class="n">${rs(b.netPaise / 100)}</td><td class="n">${b.trades}</td><td class="n">${b.meetings}</td><td>${b.open ? 'yes' : 'no'}</td></tr>`).join('')}</tbody></table></div>`
    : `<div class="pending"><strong>No live paper books yet</strong><p>The live desk runs the same bots on delayed 5-minute bars in finite, owner-started sessions. It is paper only.</p></div>`;
})();

document.getElementById('log-lede').textContent = D.latestWeek ? `Every meeting from ${D.latestWeek}. Analysts form views separately; the manager sees only their views.` : '';
document.getElementById('log').innerHTML = `<thead><tr><th>Time</th><th>Trend</th><th>Reversion</th><th>Decision</th><th>Manager's reason</th></tr></thead><tbody>${
  D.meetings.map(m => m.kind === 'meeting'
    ? `<tr><td class="n">${esc(m.when)}</td><td>${esc(m.trend)}</td><td>${esc(m.reversion)}</td><td><span class="act ${esc(m.action)}">${esc(m.action)}</span>${m.vetoes.length ? ' (vetoed ' + esc(m.proposed) + ')' : ''}</td><td class="note">${esc(m.note)}</td></tr>`
    : `<tr><td class="n">${esc(m.when)}</td><td colspan="2">${m.kind === 'blocked' ? 'Data steward blocked the meeting' : m.kind === 'risk-stop' ? 'Risk officer stop-loss' : esc(m.kind)}</td><td><span class="act ${esc(m.action)}">${esc(m.action)}</span></td><td class="note">${esc(m.note || '')}</td></tr>`).join('')}</tbody>`;
</script>
</body>
</html>
'''


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--control', default='eight-weeks-v1')
    parser.add_argument('--treated', default='eight-weeks-v1-walkforward')
    parser.add_argument('--out', type=Path, default=OUT)
    args = parser.parse_args(argv)
    args.out.write_text(render(collect(args.control, args.treated)), encoding='utf-8')
    print(args.out)


if __name__ == '__main__':
    main()
