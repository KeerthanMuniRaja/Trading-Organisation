import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Monitor, REPLAY_RULES, actions, previousCloses, replayQuotes, runSession } from './intraday-monitor.mjs';

const SHARES = ['AXISBANK', 'HDFCBANK', 'ICICIBANK', 'INFY', 'ITC', 'NTPC', 'RELIANCE', 'SBIN'];
const PREV = Object.fromEntries(SHARES.map(s => [s, 100_000]));
const HELD = [{ bot_id: 'momentum-rules', symbol: 'HDFCBANK', quantity: '2', cost_paise: '196000' },
  { bot_id: 'momentum-rules', symbol: 'AXISBANK', quantity: '1', cost_paise: '99000' }];
const T0 = Date.parse('2026-10-09T09:20:00+05:30');
const quote = (symbol, movePct, time = T0) => { const mid = 100_000 * (1 + movePct / 100); return { symbol, time, bidPaise: mid - 25, askPaise: mid + 25 }; };

test('a held share falling 5% warns once; a loss of 3% on the positions warns once', () => {
  const m = new Monitor({ positions: HELD, previousClose: PREV });
  assert.deepEqual(m.onQuote(quote('INFY', -9)).events, []); // not held: no share alert
  const drop = m.onQuote(quote('HDFCBANK', -5.5, T0 + 1000)).events;
  assert.deepEqual(drop.map(e => e.rule), ['share-drop', 'portfolio-loss']); // two of the three held units fell 5.5%: positions -3.7%
  assert.equal(drop[0].severity, 'warning');
  assert.deepEqual(m.onQuote(quote('HDFCBANK', -5.8, T0 + 2000)).events, []); // raised once a day
  const snap = m.snapshot(T0 + 2000);
  assert.equal(snap.positions.find(p => p.symbol === 'HDFCBANK').movePct, -5.8);
  assert.ok(snap.pnlTodayPaise < 0);
});

test('a market-wide crash pulls the kill switch: a critical event, raised once', () => {
  const m = new Monitor({ positions: HELD, previousClose: PREV });
  let events = [];
  for (const s of SHARES) events = events.concat(m.onQuote(quote(s, -4.5)).events);
  const kill = events.filter(e => e.rule === 'kill-switch');
  assert.equal(kill.length, 1);
  assert.equal(kill[0].severity, 'critical');
  assert.match(kill[0].message, /New risk halted until the owner resumes/);
  // before every share has a price, a fall in a few shares is not yet a market crash
  const early = new Monitor({ positions: [], previousClose: PREV });
  assert.deepEqual(early.onQuote(quote('ITC', -9)).events, []);
});

test('bad prints and crossed books are ignored, never acted on; a silent feed is reported', () => {
  const m = new Monitor({ positions: HELD, previousClose: PREV });
  assert.equal(m.onQuote(quote('HDFCBANK', -40)).accepted, false); // a 40% "fall" is a bad print
  assert.equal(m.onQuote({ symbol: 'HDFCBANK', time: T0, bidPaise: 101_000, askPaise: 100_000 }).accepted, false);
  assert.equal(m.onQuote(quote('UNKNOWN', 0)).accepted, false);
  assert.equal(m.snapshot(T0).quotesIgnored, 3);
  m.onQuote(quote('HDFCBANK', 0));
  assert.deepEqual(m.checkStale(T0 + 60_000), []);
  assert.equal(m.checkStale(T0 + 180_000)[0].rule, 'feed-stale');
});

test('the actions: the kill switch files a critical incident as the evaluator; warnings go to the outbox; dry-run does nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'intraday-'));
  try {
    const sent = [];
    const fetchImpl = async (url, init) => { sent.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) }); return { ok: true }; };
    const env = { PRINCIPALS_JSON: JSON.stringify([{ role: 'evaluator', token: 'e' }]), API_URL: 'http://127.0.0.1:9', ALERT_OUTBOX: join(dir, 'outbox.jsonl') };
    const act = actions(env, { fetchImpl, root: dir });
    assert.equal(await act({ rule: 'kill-switch', subject: 'organisation', severity: 'critical', message: 'crash', at: '2026-10-09T04:00:00.000Z' }), 'incident');
    assert.deepEqual([sent[0].url, sent[0].auth, sent[0].body.severity], ['http://127.0.0.1:9/v1/incidents', 'Bearer e', 'critical']);
    assert.equal(await act({ rule: 'share-drop', subject: 'ITC', severity: 'warning', message: 'drop', at: '2026-10-09T04:00:00.000Z' }), 'outbox');
    assert.match(await readFile(join(dir, 'outbox.jsonl'), 'utf8'), /intraday-share-drop/);
    assert.equal(await actions(env, { fetchImpl, root: dir, dryRun: true })({ severity: 'critical' }), 'dry-run');
    assert.equal(sent.length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a replayed day: recorded bars become quotes, every accepted quote is recorded, and the summary is written', async () => {
  const root = await mkdtemp(join(tmpdir(), 'replay-'));
  try {
    await mkdir(join(root, '.local', 'trading-desk', 'datasets'), { recursive: true });
    await mkdir(join(root, '.local', 'trading-desk', 'daily'), { recursive: true });
    for (const s of SHARES) {
      await writeFile(join(root, '.local', 'trading-desk', 'daily', `${s}.NS-1d.json`), JSON.stringify({ bars: [{ date: '2026-10-08', closePaise: 100_000 }, { date: '2026-10-09', closePaise: 1 }] }));
      const bars = [0, 1, 2].map(k => ({ time: `2026-10-09T09:${15 + 5 * k}:00+05:30`, closePaise: s === 'HDFCBANK' ? 100_000 - 3000 * k : 100_000 }));
      await writeFile(join(root, '.local', 'trading-desk', 'datasets', `${s}.NS-5m-2026-10-09.json`), JSON.stringify({ bars }));
    }
    assert.deepEqual(await previousCloses('2026-10-09', root), PREV); // the day before, never the day itself
    const quotes = await replayQuotes('2026-10-09', root);
    assert.equal(quotes.length, 24);
    assert.ok(quotes.every(q => q.askPaise > q.bidPaise));
    const summary = await runSession({ day: '2026-10-09', quotes, positions: HELD, previousClose: PREV, rules: REPLAY_RULES, root, act: async () => 'test' });
    assert.equal(summary.accepted, 24);
    // HDFCBANK -3% then -6%: positions -2% (nothing yet), then -4%: the share and the positions both warn, once
    assert.deepEqual(summary.events.map(e => e.rule), ['share-drop', 'portfolio-loss']);
    assert.equal((await readFile(join(root, '.local', 'intraday', 'replay', '2026-10-09', 'quotes.jsonl'), 'utf8')).trim().split('\n').length, 24);
    assert.equal(summary.mode, 'replay');
    assert.ok(existsSync(join(root, '.local', 'intraday', 'latest.json')));
  } finally { await rm(root, { recursive: true, force: true }); }
});
