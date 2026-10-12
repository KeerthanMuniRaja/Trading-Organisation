import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, config, owner, researcher, evaluator, trader, market, key } from './helpers.js';
import { TradeSignals, scoreCall, trackRecord, COST_BPS } from '../src/trade-signals.js';
import { Database } from '../src/database.js';
import { createApp } from '../src/app.js';

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
/** Validation messages live in the HTTP response body (zod issues), not in the exception's headline message. */
const says = (pattern: RegExp) => (error: any) => pattern.test(JSON.stringify(error?.getResponse?.() ?? error?.message));

async function setup() {
  const f = await fixture();
  const e = await f.evidence();
  await f.deposit('500000');
  await f.org.bot(owner, key(), { id: 'bot-one', name: 'Fixture', department: 'desk', specialty: 'demo', method: 'test', contribution: 'Signal fixture', budgetPaise: '1000000' });
  await f.db.transaction(tx => tx.query("UPDATE bots SET state='paper' WHERE id='bot-one'"));
  await f.paper.quote(market, key(), { symbol: 'DEMO', bidPaise: '10000', askPaise: '10000', observedAt: new Date().toISOString(), sourceId: e.sourceId });
  const long = { botId: 'bot-one', symbol: 'DEMO', action: 'enter-long', horizonDays: 20, conviction: 'high', probabilityPct: 60,
    thesis: 'Uptrend above the 200-day average with improving results', invalidation: 'Close below the 200-day average',
    expiresAt: inDays(2), evidenceIds: [e.evidenceId], model: 'Qwen3.5-4B-Q4_K_M', promptVersion: 'v1' };
  return { ...f, e, signals: new TradeSignals(f.db, f.cfg), long };
}

test('scoring rules are fixed and the same for every bot', () => {
  assert.equal(scoreCall('enter-long', COST_BPS + 1), true);
  assert.equal(scoreCall('enter-long', COST_BPS), false); // a gain eaten by costs is not a win
  assert.equal(scoreCall('exit', -1), true);
  assert.equal(scoreCall('exit', 50), false);
  assert.equal(scoreCall('no-action', 10), true);
  assert.equal(scoreCall('no-action', 200), false); // a profitable long was missed
  const record = trackRecord([
    { botId: 'b', conviction: 'high', outcome: { correct: true, brier: 0.09 } },
    { botId: 'b', conviction: 'high', outcome: { correct: false, brier: 0.49 } },
    { botId: 'b', conviction: 'low', outcome: null }]);
  assert.deepEqual(record, [{ botId: 'b', scored: 2, accuracy: 0.5, meanBrier: 0.29,
    byConviction: { low: { scored: 0, accuracy: null }, medium: { scored: 0, accuracy: null }, high: { scored: 2, accuracy: 0.5 } } }]);
});

test('a proposal must be complete, evidenced, bounded in time and made under the bot\'s own identity', async () => {
  const f = await setup(); try {
    const first = await f.signals.propose(trader, key(), f.long);
    assert.equal(first.duplicate, false);
    assert.equal((await f.signals.propose(trader, key(), f.long)).duplicate, true);
    assert.throws(() => f.signals.propose(trader, key(), { ...f.long, invalidation: undefined }), says(/prove it wrong/));
    assert.throws(() => f.signals.propose(trader, key(), { ...f.long, evidenceIds: [] }), says(/cite verified evidence/));
    assert.throws(() => f.signals.propose(trader, key(), { ...f.long, botId: 'someone-else' }), says(/own identity/));
    assert.throws(() => f.signals.propose(trader, key(), { ...f.long, horizonDays: 1, expiresAt: inDays(3) }), says(/outlive/));
    assert.throws(() => f.signals.propose(trader, key(), { ...f.long, expiresAt: inDays(-1) }), says(/future/));
    assert.throws(() => f.signals.propose(evaluator, key(), f.long)); // evaluators review, they do not propose
    const unverified = await f.org.evidence(researcher, key(), { sourceId: f.e.sourceId, kind: 'dataset', content: 'Unreviewed note ' + key(), publishedAt: '2025-01-01T00:00:00Z' });
    await assert.rejects(() => f.signals.propose(trader, key(), { ...f.long, evidenceIds: [unverified.id] }), says(/verified/));
    const quiet = await f.signals.propose(trader, key(), { botId: 'bot-one', symbol: 'DEMO', action: 'no-action', horizonDays: 5, conviction: 'medium',
      thesis: 'No edge: the move is already priced in', expiresAt: inDays(1) });
    assert.equal(quiet.duplicate, false); // an explicit no-action call needs no evidence or invalidation
  } finally { await f.db.close(); }
});

test('the risk review is deterministic: code sizes accepted trades and records every rejection reason', async () => {
  const f = await setup(); try {
    const high = await f.signals.propose(trader, key(), f.long);
    assert.throws(() => f.signals.review(trader, key(), { signalId: high.id })); // a trader cannot review
    const accepted = await f.signals.review(evaluator, key(), { signalId: high.id });
    // binding limit is available capital (500000 paise) at a 10000-paise ask: high conviction uses all of it
    assert.deepEqual([accepted.outcome, accepted.side, accepted.quantity], ['accepted', 'buy', '50']);
    assert.deepEqual(accepted.reasons, ['sized-by-available-capital', 'conviction-high']);
    assert.equal((await f.signals.review(evaluator, key(), { signalId: high.id })).duplicate, true);
    const medium = await f.signals.propose(trader, key(), { ...f.long, conviction: 'medium', thesis: 'Smaller conviction' });
    assert.equal((await f.signals.review(evaluator, key(), { signalId: medium.id })).quantity, '25');
    // the accepted intent goes through paper trading, which re-checks every limit itself
    const order = await f.paper.reserve(trader, key(), { botId: 'bot-one', symbol: 'DEMO', side: 'buy', quantity: 50, evidenceId: f.e.evidenceId });
    assert.equal(order.state, 'reserved');

    const unsure = await f.signals.propose(trader, key(), { ...f.long, probabilityPct: 40, thesis: 'Coin flip at best' });
    assert.deepEqual((await f.signals.review(evaluator, key(), { signalId: unsure.id })).reasons, ['stated-probability-below-even']);
    const noQuote = await f.signals.propose(trader, key(), { ...f.long, symbol: 'OTHER' });
    assert.deepEqual((await f.signals.review(evaluator, key(), { signalId: noQuote.id })).reasons, ['no-fresh-approved-quote']);
    const exit = await f.signals.propose(trader, key(), { ...f.long, action: 'exit', thesis: 'Trend broke' });
    assert.deepEqual((await f.signals.review(evaluator, key(), { signalId: exit.id })).reasons, ['no-unreserved-position']);
    const none = await f.signals.propose(trader, key(), { botId: 'bot-one', symbol: 'DEMO', action: 'no-action', horizonDays: 5, conviction: 'low',
      thesis: 'Nothing to do', expiresAt: inDays(1) });
    assert.equal((await f.signals.review(evaluator, key(), { signalId: none.id })).outcome, 'acknowledged');

    await f.db.transaction(tx => tx.query('UPDATE system_lock SET halted=true WHERE id=1'));
    const halted = await f.signals.propose(trader, key(), { ...f.long, thesis: 'During a halt' });
    const review = await f.signals.review(evaluator, key(), { signalId: halted.id });
    assert.equal(review.outcome, 'rejected');
    assert.ok(review.reasons.includes('system-halted'));
    await assert.rejects(() => f.db.transaction(tx => tx.query("UPDATE trade_signal_reviews SET outcome='accepted'")));
    assert.equal((await f.ops.verifyAudit(owner)).valid, true);
  } finally { await f.db.close(); }
});

test('outcomes are scored only after the horizon, by an independent evaluator, into a calibrated track record', async () => {
  const f = await setup(); try {
    const fresh = await f.signals.propose(trader, key(), f.long);
    await f.signals.review(evaluator, key(), { signalId: fresh.id });
    await assert.rejects(() => f.signals.outcome(evaluator, key(), { signalId: fresh.id, exitPricePaise: '10500', observedAt: new Date().toISOString(),
      evidenceId: f.e.evidenceId }), says(/horizon has not passed/));
    // an older signal whose horizon has passed (inserted directly: history cannot be back-dated through the API)
    const past = async (action: string, probability: number | null) => {
      const signalId = crypto.randomUUID();
      await f.db.transaction(async tx => {
        await tx.query(`INSERT INTO trade_signals(id,bot_id,symbol,action,horizon_days,conviction,probability_pct,thesis,invalidation,expires_at,author,content_hash,created_at)
          VALUES($1,'bot-one','DEMO',$2,5,'high',$3,'Past call','Invalidation',now()-interval '8 days','trader',$4,now()-interval '10 days')`,
          [signalId, action, probability, key()]);
        await tx.query(`INSERT INTO trade_signal_reviews(id,signal_id,outcome,reasons,reference_price_paise,rules_version,reviewer)
          VALUES($1,$2,'rejected',ARRAY['test']::text[],10000,'signal-risk-v1','evaluator')`, [crypto.randomUUID(), signalId]);
      });
      return signalId;
    };
    const longCall = await past('enter-long', 70), exitCall = await past('exit', null);
    const now = new Date().toISOString();
    assert.throws(() => f.signals.outcome(researcher, key(), { signalId: longCall, exitPricePaise: '10400', observedAt: now, evidenceId: f.e.evidenceId }));
    const won = await f.signals.outcome(evaluator, key(), { signalId: longCall, exitPricePaise: '10400', observedAt: now, evidenceId: f.e.evidenceId });
    assert.deepEqual([won.moveBps, won.correct], [400, true]);
    assert.ok(Math.abs(won.brier! - 0.09) < 1e-9); // said 70%, was right
    const exitScore = await f.signals.outcome(evaluator, key(), { signalId: exitCall, exitPricePaise: '9800', observedAt: now, evidenceId: f.e.evidenceId });
    assert.deepEqual([exitScore.moveBps, exitScore.correct, exitScore.brier], [-200, true, null]);
    const mine = await f.signals.query(trader, {});
    assert.equal(mine.trackRecord[0]!.scored, 2);
    assert.equal(mine.trackRecord[0]!.accuracy, 1);
    assert.equal(mine.signals.find(s => s.id === fresh.id)!.review!.outcome, 'accepted');
    assert.throws(() => f.signals.query(trader, { botId: 'another-bot' }), says(/own signals/));
  } finally { await f.db.close(); }
});

test('signal routes are registered and guarded by role', async () => {
  const { cfg } = config(), db = await Database.open(), app = await createApp(cfg, db, true);
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const call = (path: string, role: string, body: unknown) => fetch(base + '/v1' + path, { method: 'POST', body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key(), Authorization: 'Bearer ' + cfg.principals.find(p => p.role === role)!.token } });
    assert.equal((await call('/trading/signals/query', 'trader', {})).status, 201);
    assert.equal((await call('/trading/signals/reviews', 'trader', { signalId: crypto.randomUUID() })).status, 403);
    assert.equal((await call('/trading/signals', 'evaluator', {})).status, 403);
    assert.equal((await call('/trading/signals/outcomes', 'market', {})).status, 403);
  } finally { await app.close(); await db.close(); }
});
