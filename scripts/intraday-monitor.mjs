// Intraday monitor (LIVE-01): watches the organisation's paper positions during the session and pulls the brake in a crash.
// Feed-agnostic: quotes come from a source ({symbol, time, bidPaise, askPaise}); today the source is a REPLAY of
// recorded 5-minute bars, and a broker's live feed plugs in later as another source. Every accepted quote is recorded
// to .local/intraday/<live|replay>/<day>/quotes.jsonl, so any live day can be replayed exactly.
//   node --env-file=.env scripts/intraday-monitor.mjs --replay 2026-10-09 [--dry-run]
// Rules (owner-editable below), each raised at most once a day per subject:
//   share-drop        a held share is SHARE_DROP_PCT below yesterday's close                       warning
//   portfolio-loss    the positions lost PORTFOLIO_LOSS_PCT of their value since yesterday's close  warning
//   kill-switch       the basket of all shares fell BASKET_CRASH_PCT, or the positions lost
//                     PORTFOLIO_CRASH_PCT: a CRITICAL incident, which halts new risk until the owner resumes   critical
//   feed-stale        no fresh quote for STALE_SECONDS during the session (the monitor is blind)  warning
//   bad-print         a quote over BAD_PRINT_PCT from yesterday's close or with a crossed book is ignored, never acted on
// What it never does: place, change or cancel an order, sell a position, or change a limit. The kill switch only stops
// NEW risk (the backend's existing brake); what to do with open positions stays the owner's decision.
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const RULES = { SHARE_DROP_PCT: 5, PORTFOLIO_LOSS_PCT: 3, BASKET_CRASH_PCT: 4, PORTFOLIO_CRASH_PCT: 6, STALE_SECONDS: 120, BAD_PRINT_PCT: 20 };
export const ASSUMED_SPREAD_BPS = 5; // replayed bars have no book: bid/ask are the close -/+ half this spread (an assumption)
export const REPLAY_RULES = { ...RULES, STALE_SECONDS: 600 }; // 5-minute bars: two missing bars make the replay blind
const pct = (a, b) => 100 * (a / b - 1);

/** Pure core: positions and yesterday's closes in, events out, one quote at a time. */
export class Monitor {
  constructor({ positions, previousClose, rules = RULES }) {
    this.rules = rules;
    this.previousClose = previousClose;                       // {SYMBOL: paise}
    this.positions = positions.filter(p => Number(p.quantity) > 0 && previousClose[p.symbol]);
    this.mid = {};
    this.raised = new Set();
    this.lastQuoteAt = null;
    this.ignored = 0;
  }

  raise(rule, subject, severity, message, at, detail = {}) {
    const key = `${rule}:${subject}`;
    if (this.raised.has(key)) return [];
    this.raised.add(key);
    return [{ rule, subject, severity, message, at: new Date(at).toISOString(), ...detail }];
  }

  value() {
    let today = 0, base = 0;
    for (const p of this.positions) {
      const q = Number(p.quantity), mid = this.mid[p.symbol] ?? this.previousClose[p.symbol];
      today += q * (mid - this.previousClose[p.symbol]);
      base += q * this.previousClose[p.symbol];
    }
    return { pnlTodayPaise: Math.round(today), basePaise: base, lossPct: base ? 100 * today / base : 0 };
  }

  basketMovePct() {
    const moves = Object.keys(this.mid).map(s => pct(this.mid[s], this.previousClose[s]));
    return moves.length ? moves.reduce((a, b) => a + b, 0) / moves.length : 0;
  }

  /** One quote: accepted or ignored, and any events it causes. */
  onQuote(q) {
    const prev = this.previousClose[q.symbol];
    if (!prev || !(q.bidPaise > 0 && q.askPaise >= q.bidPaise) || Math.abs(pct((q.bidPaise + q.askPaise) / 2, prev)) > this.rules.BAD_PRINT_PCT) {
      this.ignored++;
      return { accepted: false, events: [] };
    }
    this.lastQuoteAt = q.time;
    this.mid[q.symbol] = (q.bidPaise + q.askPaise) / 2;
    const events = [];
    const move = pct(this.mid[q.symbol], prev);
    if (this.positions.some(p => p.symbol === q.symbol) && move <= -this.rules.SHARE_DROP_PCT)
      events.push(...this.raise('share-drop', q.symbol, 'warning', `${q.symbol} is ${move.toFixed(1)}% below yesterday's close`, q.time, { movePct: +move.toFixed(2) }));
    const v = this.value(), basket = this.basketMovePct(), all = Object.keys(this.mid).length === Object.keys(this.previousClose).length;
    if (v.lossPct <= -this.rules.PORTFOLIO_LOSS_PCT)
      events.push(...this.raise('portfolio-loss', 'positions', 'warning', `Positions down ${v.lossPct.toFixed(1)}% since yesterday's close`, q.time, { lossPct: +v.lossPct.toFixed(2) }));
    if (v.lossPct <= -this.rules.PORTFOLIO_CRASH_PCT || (all && basket <= -this.rules.BASKET_CRASH_PCT))
      events.push(...this.raise('kill-switch', 'organisation', 'critical',
        `Crash brake: basket ${basket.toFixed(1)}%, positions ${v.lossPct.toFixed(1)}% since yesterday's close. New risk halted until the owner resumes.`,
        q.time, { basketMovePct: +basket.toFixed(2), lossPct: +v.lossPct.toFixed(2) }));
    return { accepted: true, events };
  }

  /** Called on a timer: a session without fresh quotes is a blind monitor. */
  checkStale(now) {
    if (this.lastQuoteAt !== null && now - this.lastQuoteAt > this.rules.STALE_SECONDS * 1000)
      return this.raise('feed-stale', 'feed', 'warning', `No fresh quote for ${Math.round((now - this.lastQuoteAt) / 1000)} s: the monitor is blind`, now);
    return [];
  }

  snapshot(at) {
    const v = this.value();
    return { at: new Date(at).toISOString(), basketMovePct: +this.basketMovePct().toFixed(2), pnlTodayPaise: v.pnlTodayPaise,
      lossPct: +v.lossPct.toFixed(2), positions: this.positions.map(p => ({ botId: p.bot_id, symbol: p.symbol, quantity: Number(p.quantity),
        movePct: this.mid[p.symbol] ? +pct(this.mid[p.symbol], this.previousClose[p.symbol]).toFixed(2) : null })),
      quotesIgnored: this.ignored, raised: [...this.raised] };
  }
}

/** Yesterday's close per share (the last daily bar before `day`), from the desk's daily files. */
export async function previousCloses(day, root = ROOT) {
  const dir = join(root, '.local', 'trading-desk', 'daily'), out = {};
  for (const name of existsSync(dir) ? await readdir(dir) : []) {
    const m = /^([A-Z0-9&-]+)\.NS-1d\.json$/.exec(name);
    if (!m) continue;
    const bars = JSON.parse(await readFile(join(dir, name), 'utf8')).bars.filter(b => b.date < day);
    if (bars.length) out[m[1]] = bars.at(-1).closePaise;
  }
  return out;
}

/** Replay source: the recorded 5-minute bars of `day`, as quotes at each bar's close with an assumed spread. */
export async function replayQuotes(day, root = ROOT, spreadBps = ASSUMED_SPREAD_BPS) {
  const dir = join(root, '.local', 'trading-desk', 'datasets'), quotes = [];
  for (const name of existsSync(dir) ? await readdir(dir) : []) {
    const m = /^([A-Z0-9&-]+)\.NS-5m-.*\.json$/.exec(name);
    if (!m) continue;
    for (const b of JSON.parse(await readFile(join(dir, name), 'utf8')).bars) {
      if (!b.time.startsWith(day)) continue;
      const half = Math.max(1, Math.round(b.closePaise * spreadBps / 20000));
      quotes.push({ symbol: m[1], time: Date.parse(b.time) + 5 * 60_000, bidPaise: b.closePaise - half, askPaise: b.closePaise + half });
    }
  }
  const seen = new Set();
  return quotes.filter(q => { const k = `${q.symbol}:${q.time}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.time - b.time || a.symbol.localeCompare(b.symbol));
}

/** Default actions: warnings to the local alert outbox; the kill switch as a critical incident (evaluator), which halts new risk. */
export function actions(env = process.env, { fetchImpl = fetch, root = ROOT, dryRun = false } = {}) {
  const outbox = resolve(env.ALERT_OUTBOX || join(root, '.local', 'alerts', 'outbox.jsonl'));
  return async event => {
    if (dryRun) return 'dry-run';
    if (event.severity === 'critical') {
      const evaluator = JSON.parse(env.PRINCIPALS_JSON || '[]').filter(p => p.role === 'evaluator');
      const base = (env.API_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
      if (evaluator.length === 1) {
        try {
          const r = await fetchImpl(base + '/v1/incidents', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + evaluator[0].token,
              'Idempotency-Key': `intraday-${event.rule}-${event.at.slice(0, 10)}` },
            body: JSON.stringify({ description: 'Intraday monitor: ' + event.message, severity: 'critical' }) });
          if (r.ok) return 'incident';
        } catch { /* fall through to the outbox: the alert must not be lost */ }
      }
    }
    await mkdir(dirname(outbox), { recursive: true });
    await appendFile(outbox, JSON.stringify({ at: event.at, severity: event.severity, rule: 'intraday-' + event.rule, subject: event.subject, message: event.message }) + '\n');
    return 'outbox';
  };
}

/** Runs one session from a list of quotes (replay) and records everything. */
export async function runSession({ day, quotes, positions, previousClose, act, root = ROOT, rules = RULES, mode = 'replay' }) {
  const monitor = new Monitor({ positions, previousClose, rules });
  // replays are kept apart from live sessions, so a replayed day can never pass for a recorded live one
  const dir = join(root, '.local', 'intraday', mode === 'live' ? 'live' : 'replay', day);
  await mkdir(dir, { recursive: true });
  const events = [];
  let accepted = 0, last = null;
  for (const q of quotes) {
    if (last !== null) for (const e of monitor.checkStale(q.time)) events.push({ ...e, action: await act(e) });
    const r = monitor.onQuote(q);
    if (r.accepted) { accepted++; await appendFile(join(dir, 'quotes.jsonl'), JSON.stringify(q) + '\n'); }
    for (const e of r.events) events.push({ ...e, action: await act(e) });
    last = q.time;
  }
  const summary = { day, mode, quotes: quotes.length, accepted, events, final: monitor.snapshot(last ?? Date.now()),
    note: 'Paper positions only. The monitor never trades; the kill switch only halts new risk.' };
  await writeFile(join(dir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  await writeFile(join(root, '.local', 'intraday', 'latest.json'), JSON.stringify(summary, null, 2) + '\n');
  return summary;
}

async function positionsFromBackend(env) {
  const owner = JSON.parse(env.PRINCIPALS_JSON || '[]').find(p => p.role === 'owner');
  if (!owner) throw new Error('Configure the owner credential to read positions');
  const r = await fetch((env.API_URL || 'http://127.0.0.1:3000').replace(/\/$/, '') + '/v1/paper/positions',
    { headers: { Authorization: 'Bearer ' + owner.token }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`positions refused (HTTP ${r.status})`);
  return r.json();
}

async function main() {
  const args = process.argv.slice(2), at = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const day = at('--replay');
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Usage: intraday-monitor.mjs --replay YYYY-MM-DD [--positions file.json] [--dry-run]  (a live feed is not configured yet)');
  const positions = at('--positions') ? JSON.parse(await readFile(at('--positions'), 'utf8')) : await positionsFromBackend(process.env);
  const quotes = await replayQuotes(day);
  if (!quotes.length) throw new Error(`No recorded 5-minute bars for ${day}`);
  const summary = await runSession({ day, quotes, positions, previousClose: await previousCloses(day), rules: REPLAY_RULES,
    act: actions(process.env, { dryRun: args.includes('--dry-run') }) });
  console.log(`${day}: ${summary.accepted}/${summary.quotes} quotes; basket ${summary.final.basketMovePct}%, positions ${summary.final.lossPct}% `
    + `(P&L today ${(summary.final.pnlTodayPaise / 100).toFixed(2)}); events: ${summary.events.map(e => `${e.rule}:${e.subject} (${e.action})`).join(', ') || 'none'}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
