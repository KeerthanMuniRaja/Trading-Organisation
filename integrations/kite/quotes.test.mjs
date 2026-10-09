import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchQuote, normalizeQuote, marketWindow } from './quotes.mjs';
import { PaperTrial } from './paper-trial.mjs';
const now = Date.parse('2026-10-08T10:00:00+05:30');
const payload = () => ({ status: 'success', data: { 'NSE:RELIANCE': {
  timestamp: '2026-10-08 10:00:00', depth: {
    buy: [{ price: 1400, quantity: 10 }], sell: [{ price: 1400.5, quantity: 12 }]
  }
} } });
test('quote preserves exchange time and converts genuine depth to paise', () => {
  const q = normalizeQuote(payload(), now);
  assert.equal(q.time, now); assert.equal(q.bidPaise, 140000); assert.equal(q.askPaise, 140050);
  assert.equal(marketWindow(Date.parse('2026-10-10T10:00:00+05:30')), false);
  assert.equal(marketWindow(Date.parse('2026-10-08T15:30:00+05:30')), false);
});
test('stale, future, repeated, missing, crossed and malformed data fail closed', () => {
  assert.throws(() => normalizeQuote(payload(), now + 10001), /STALE/);
  assert.throws(() => normalizeQuote(payload(), now - 2001), /FUTURE/);
  assert.throws(() => normalizeQuote(payload(), now, now), /NON_ADVANCING/);
  assert.throws(() => normalizeQuote({ status: 'success', data: {} }, now), /INVALID_QUOTE/);
  const p = payload(); p.data['NSE:RELIANCE'].depth.sell[0].price = 1399;
  assert.throws(() => normalizeQuote(p, now), /INVALID_DEPTH/);
  p.data['NSE:RELIANCE'].depth.sell[0].price = 1400.001;
  assert.throws(() => normalizeQuote(p, now), /INVALID_PRICE/);
  p.data['NSE:RELIANCE'].timestamp = '2026-02-30 10:00:00';
  assert.throws(() => normalizeQuote(p, now), /INVALID_TIMESTAMP/);
});
test('request is fixed GET-only, redirect rejecting, bounded and error-redacted', async () => {
  const config = { apiKey: 'testkey', accessToken: 'testtoken', now: () => now };
  const q = await fetchQuote({ ...config, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.kite.trade/quote?i=NSE%3ARELIANCE');
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify(payload()));
  } });
  assert.equal(q.bidPaise, 140000);
  await assert.rejects(fetchQuote({ ...config, fetchImpl: async () => { throw Error('testtoken'); } }), /^Error: QUOTE_REQUEST_FAILED$/);
  await assert.rejects(fetchQuote({ ...config, fetchImpl: async () => new Response('testtoken', { status: 403 }) }), /KITE_ACCESS_DENIED/);
  await assert.rejects(fetchQuote({ ...config, fetchImpl: async () => new Response('x'.repeat(65537)) }), /RESPONSE_TOO_LARGE/);
  await assert.rejects(fetchQuote({ ...config, apiKey: '', fetchImpl: () => assert.fail('must not request') }), /CREDENTIALS_REQUIRED/);
});
test('deadline aborts response-body reads as well as the request', async () => {
  await assert.rejects(fetchQuote({ apiKey: 'testkey', accessToken: 'testtoken', timeoutMs: 10,
    fetchImpl: async (_, { signal }) => new Response(new ReadableStream({ start(controller) {
      signal.addEventListener('abort', () => controller.error(Error('aborted')), { once: true });
    } })) }), /QUOTE_TIMEOUT/);
});
function quote(i, bid = 140000 + i * 30) {
  return { time: now + i * 5000, observedAt: new Date(now + i * 5000).toISOString(),
    bidPaise: bid, askPaise: bid + 10, bidQuantity: 10, askQuantity: 10 };
}
test('paper trial records costs, cash conservation and a fresh end close', () => {
  const t = new PaperTrial();
  for (let i = 0; i < 12; i++) t.step(quote(i));
  assert.equal(t.trades.length, 1); assert.equal(t.trades[0].side, 'buy');
  assert.equal(t.cashPaise + t.position.costPaise, t.initialPaise);
  assert.equal(t.step(quote(12), true), 'sell');
  assert.equal(t.position, null);
  assert.equal(t.cashPaise - t.initialPaise, t.realisedNetPaise);
  assert.equal(t.report().unrealisedNetPaise, 0);
  assert.ok(t.trades.every(x => x.feePaise > 0));
  assert.throws(() => t.step(quote(12)), /INVALID_SIMULATION/);
});
test('no entry above allocation cap, wide spread or on final quote', () => {
  for (const kind of ['cost', 'spread', 'closing']) {
    const t = new PaperTrial();
    for (let i = 0; i < 20; i++) {
      const q = quote(i, (kind === 'cost' ? 250000 : 140000) + i * 100);
      if (kind === 'spread') q.askPaise = q.bidPaise + 1000;
      t.step(q, kind === 'closing');
    }
    assert.equal(t.trades.length, 0);
  }
});
test('feed loss retains an open position marked at last observation', () => {
  const t = new PaperTrial();
  for (let i = 0; i < 12; i++) t.step(quote(i));
  const report = t.report();
  assert.equal(report.position.quantity, 1);
  assert.equal(report.valuationAsOf, quote(11).observedAt);
  assert.equal(report.realisedNetPaise, 0);
  assert.ok(report.unrealisedNetPaise < 0);
});
