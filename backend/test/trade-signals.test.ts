import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, config, owner, researcher, evaluator, trader, market, key } from './helpers.js';
import { TradeSignals, scoreCall, trackRecord, challengerRecord, COST_BPS } from '../src/trade-signals.js';
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
    // a stated target weight caps the size: 20% of the 1000000-paise budget is 200000 paise, 20 shares at 10000
    const targeted = await f.signals.propose(trader, key(), { ...f.long, targetWeightPct: 20, thesis: 'Raise to 20% of the book' });
    assert.throws(() => f.signals.review(trader, key(), { signalId: targeted.id })); // a trader cannot review
    const capped = await f.signals.review(evaluator, key(), { signalId: targeted.id });
    assert.deepEqual([capped.outcome, capped.side, capped.quantity, capped.reasons[0]], ['accepted', 'buy', '20', 'sized-by-target-weight']);
    assert.equal((await f.signals.review(evaluator, key(), { signalId: targeted.id })).duplicate, true);
    // accepted intents not yet executed are committed: 500000 available minus 200000 leaves 300000; medium uses half
    const medium = await f.signals.propose(trader, key(), { ...f.long, conviction: 'medium', thesis: 'Smaller conviction' });
    const sized = await f.signals.review(evaluator, key(), { signalId: medium.id });
    assert.deepEqual([sized.quantity, sized.reasons], ['15', ['sized-by-available-capital', 'conviction-medium']]);
    // high conviction takes all that is left (150000), and the next one finds no room at all
    const high = await f.signals.propose(trader, key(), f.long);
    assert.deepEqual([(await f.signals.review(evaluator, key(), { signalId: high.id })).quantity], ['15']);
    const late = await f.signals.propose(trader, key(), { ...f.long, thesis: 'One more' });
    assert.deepEqual((await f.signals.review(evaluator, key(), { signalId: late.id })).reasons, ['size-below-one-share', 'available-capital']);

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

test('an independent challenger argues before review; an evidenced objection halves a high-conviction size', async () => {
  const f = await setup(); try {
    await f.org.bot(owner, key(), { id: 'skeptic', name: 'Skeptic', department: 'desk', specialty: 'challenge', method: 'reasoning', contribution: 'Challenger', budgetPaise: '0' });
    const skeptic = { id: 'skeptic-worker', role: 'researcher' as const, botId: 'skeptic' };
    const high = await f.signals.propose(trader, key(), f.long);
    assert.throws(() => f.signals.challenge(evaluator, key(), { signalId: high.id, stance: 'oppose', argument: 'x' })); // evaluators review, not argue
    await assert.rejects(() => f.signals.challenge(trader, key(), { signalId: high.id, stance: 'oppose', argument: 'Second thoughts' }), says(/own proposal/));
    await f.signals.challenge(skeptic, key(), { signalId: high.id, stance: 'oppose', argument: 'Results due next week; drawdown risk', evidenceId: f.e.evidenceId });
    await assert.rejects(() => f.signals.challenge(skeptic, key(), { signalId: high.id, stance: 'oppose', argument: 'Again' }), says(/already challenged/));
    const reviewed = await f.signals.review(evaluator, key(), { signalId: high.id });
    assert.deepEqual([reviewed.quantity, reviewed.reasons], ['25', ['evidenced-objection-sized-as-medium', 'sized-by-available-capital', 'conviction-medium']]);
    assert.equal(reviewed.rulesVersion, 'signal-risk-v2');
    await assert.rejects(() => f.signals.challenge({ ...skeptic, id: 'other', botId: 'bot-two' }, key(), { signalId: high.id, stance: 'oppose', argument: 'Late' }),
      says(/before the review/));

    // an objection without evidence is recorded and visible, but does not change the size
    const another = await f.signals.propose(trader, key(), { ...f.long, thesis: 'Second idea' });
    await f.signals.challenge(skeptic, key(), { signalId: another.id, stance: 'oppose', argument: 'I just do not like it' });
    // the first accepted intent committed 250000 paise, so 250000 remains; high conviction keeps all of it (not halved)
    const unhalved = await f.signals.review(evaluator, key(), { signalId: another.id });
    assert.deepEqual([unhalved.quantity, unhalved.reasons], ['25', ['sized-by-available-capital', 'conviction-high']]);
    const view = await f.signals.query(owner, {});
    assert.equal(view.signals.find(s => s.id === another.id)!.challenges[0]!.argument, 'I just do not like it');
  } finally { await f.db.close(); }
});

test('challengers are scored: an opposition is right when the call was wrong', () => {
  const record = challengerRecord([
    { outcome: { correct: false }, challenges: [{ challengerBotId: 'skeptic', stance: 'oppose' }] },
    { outcome: { correct: true }, challenges: [{ challengerBotId: 'skeptic', stance: 'oppose' }, { challengerBotId: 'ally', stance: 'support-with-caveat' }] },
    { outcome: null, challenges: [{ challengerBotId: 'skeptic', stance: 'oppose' }] }]);
  assert.deepEqual(record, [{ botId: 'ally', scored: 1, right: 1, opposed: 0, accuracy: 1 }, { botId: 'skeptic', scored: 2, right: 1, opposed: 2, accuracy: 0.5 }]);
});

test('an accepted proposal executes once as a linked paper order and fill; retries resume, never double-trade', async () => {
  const f = await setup(); try {
    const buy = await f.signals.propose(trader, key(), { ...f.long, conviction: 'medium' });
    await assert.rejects(() => f.signals.execute(trader, key(), { signalId: buy.id }), says(/accepted review/)); // not reviewed yet
    await f.signals.review(evaluator, key(), { signalId: buy.id });
    await assert.rejects(() => f.signals.execute(evaluator, key(), { signalId: buy.id })); // only trader credentials execute
    await assert.rejects(() => f.signals.execute({ id: 'other', role: 'trader', botId: 'bot-two' }, key(), { signalId: buy.id }), says(/proposing bot/));

    // a stale quote makes the fill fail, but the reservation stays and the same call succeeds once prices are fresh
    await f.db.transaction(tx => tx.query("UPDATE quotes SET observed_at=now()-interval '5 minutes'"));
    await assert.rejects(() => f.signals.execute(trader, key(), { signalId: buy.id }), says(/Fresh approved quote/));
    await f.paper.quote(market, key(), { symbol: 'DEMO', bidPaise: '10000', askPaise: '10000', observedAt: new Date().toISOString(), sourceId: f.e.sourceId });
    const done = await f.signals.execute(trader, key(), { signalId: buy.id });
    assert.deepEqual([done.side, done.quantity, done.pricePaise, done.realisedPaise, done.duplicate], ['buy', '25', '10000', null, false]);
    const again = await f.signals.execute(trader, key(), { signalId: buy.id });
    assert.deepEqual([again.orderId, again.duplicate], [done.orderId, true]);
    const orders = (await f.db.transaction(tx => tx.query("SELECT status FROM orders WHERE bot_id='bot-one'"))).rows;
    assert.deepEqual(orders.map(o => o.status), ['filled']); // exactly one order, even after the failed attempt

    // the exit executes as a sell of the whole position and records its realised profit
    await f.paper.quote(market, key(), { symbol: 'DEMO', bidPaise: '11000', askPaise: '11000', observedAt: new Date(Date.now() + 1000).toISOString(), sourceId: f.e.sourceId });
    const exit = await f.signals.propose(trader, key(), { ...f.long, action: 'exit', thesis: 'Target reached' });
    await f.signals.review(evaluator, key(), { signalId: exit.id });
    const sold = await f.signals.execute(trader, key(), { signalId: exit.id });
    assert.deepEqual([sold.side, sold.quantity, sold.realisedPaise], ['sell', '25', '25000']); // 25 shares x 1000 paise gain, no fees in the fixture
    const view = await f.signals.query(owner, {});
    assert.equal(view.signals.find(s => s.id === exit.id)!.execution!.realisedPaise, '25000');
    await assert.rejects(() => f.db.transaction(tx => tx.query('UPDATE trade_signal_executions SET realised_paise=0')));
    assert.equal((await f.ops.verifyAudit(owner)).valid, true);
  } finally { await f.db.close(); }
});

test('end-of-day execution: reviewed at a verified close, filled at a verified price observed after the review', async () => {
  const f = await setup(); try {
    await f.db.transaction(tx => tx.query("UPDATE quotes SET observed_at=now()-interval '1 day'")); // no live quote feed
    const price = async (kind: string, paise: number) => {
      const e = await f.org.evidence(researcher, key(), { sourceId: f.e.sourceId, kind: 'dataset',
        content: `${kind} of NSE:DEMO on 2026-10-14: ${paise} paise. Source: daily bars ${key()}.`, publishedAt: new Date().toISOString() });
      await f.org.reviewEvidence(evaluator, key(), { evidenceId: e.id, status: 'verified' });
      return e.id as string;
    };
    const buy = await f.signals.propose(trader, key(), { ...f.long, conviction: 'medium' });
    assert.deepEqual((await f.signals.review(evaluator, key(), { signalId: buy.id })).reasons, ['no-fresh-approved-quote']); // nothing to price with
    const another = await f.signals.propose(trader, key(), { ...f.long, conviction: 'medium', thesis: 'Priced at the close' });
    const closeId = await price('Daily close', 10000);
    const reviewed = await f.signals.review(evaluator, key(), { signalId: another.id, priceEvidence: { evidenceId: closeId, pricePaise: '10000',
      observedAt: new Date(Date.now() - 3_600_000).toISOString() } });
    assert.deepEqual([reviewed.outcome, reviewed.quantity], ['accepted', '25']);
    assert.equal(reviewed.reasons.at(-1), 'priced-from-verified-close');

    const openId = await price('Opening price', 10200);
    // hindsight is refused: a price observed before the review cannot be used
    await assert.rejects(() => f.signals.execute(trader, key(), { signalId: another.id, priceEvidence: { evidenceId: openId, pricePaise: '10200',
      observedAt: new Date(Date.now() - 7_200_000).toISOString() } }), says(/after the review/));
    // a price the evidence does not state is refused by the paper engine itself
    await assert.rejects(() => f.signals.execute(trader, key(), { signalId: another.id, priceEvidence: { evidenceId: openId, pricePaise: '9000',
      observedAt: new Date().toISOString() } }), says(/does not state this price/));
    const filled = await f.signals.execute(trader, key(), { signalId: another.id, priceEvidence: { evidenceId: openId, pricePaise: '10200',
      observedAt: new Date().toISOString() } });
    assert.deepEqual([filled.side, filled.quantity, filled.pricePaise], ['buy', '25', '10200']); // the next open, verified
    const position = (await f.db.transaction(tx => tx.query("SELECT quantity::text AS q,cost_paise::text AS c FROM positions WHERE bot_id='bot-one'"))).rows[0]!;
    assert.deepEqual([position.q, position.c], ['25', '255000']);
    assert.equal((await f.ops.verifyAudit(owner)).valid, true);
  } finally { await f.db.close(); }
});

test('cursor pagination reaches every signal; the unscored filter returns only reviewed signals awaiting an outcome', async () => {
  const f = await setup(); try {
    const ids: string[] = [];
    await f.db.transaction(async tx => {
      for (let i = 0; i < 7; i++) {
        const id = crypto.randomUUID();
        ids.push(id);
        // identical timestamps for some rows: the cursor must still neither skip nor repeat any of them
        await tx.query(`INSERT INTO trade_signals(id,bot_id,symbol,action,horizon_days,conviction,thesis,invalidation,expires_at,author,content_hash,created_at)
          VALUES($1,'bot-one','DEMO','enter-long',5,'low','t','i',now()+interval '1 day','trader',$2,timestamp '2026-10-01 10:00:00' + ($3::int / 3) * interval '1 second')`,
          [id, key(), i]);
        if (i % 2 === 0) await tx.query(`INSERT INTO trade_signal_reviews(id,signal_id,outcome,reasons,reference_price_paise,rules_version,reviewer)
          VALUES($1,$2,'rejected',ARRAY['t']::text[],10000,'signal-risk-v2','evaluator')`, [crypto.randomUUID(), id]);
      }
    });
    const seen: string[] = [];
    let before: string | null = null, pages = 0;
    do {
      const page = await f.signals.query(owner, { limit: 3, ...(before ? { before } : {}) });
      seen.push(...page.signals.map(s => s.id));
      before = page.nextBefore; pages++;
    } while (before);
    assert.equal(seen.length, 7);
    assert.equal(new Set(seen).size, 7); // no repeats
    assert.deepEqual([...seen].sort(), [...ids].sort()); // nothing skipped
    assert.equal(pages, 3);
    const unscored = await f.signals.query(owner, { pending: 'unscored', limit: 200 });
    assert.deepEqual(unscored.signals.map(s => s.id).sort(), ids.filter((_, i) => i % 2 === 0).sort());
    assert.throws(() => f.signals.query(owner, { before: 'not-a-cursor' }));
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
