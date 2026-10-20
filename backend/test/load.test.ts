import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, owner, evaluator, market, key } from './helpers.js';
import { TradeSignals } from '../src/trade-signals.js';
import { Actor } from '../src/core.js';

// SCALE-01 load test: many bots propose, are reviewed and execute concurrently through the real trading path.
// Every write takes the global lock, so this measures contention and proves the money invariants hold under load:
// no double execution, no negative wallet, balanced journals, exposure within the limit, an intact audit chain.
const BOTS = 5, PER_BOT = 12;

test('concurrent proposals, reviews and executions keep every money invariant', async t => {
  const f = await fixture(); try {
    const e = await f.evidence();
    await f.deposit('20000000'); // Rs 2,00,000 of paper capital
    const traders: Actor[] = [];
    for (let b = 0; b < BOTS; b++) {
      const id = `load-${b}`;
      await f.org.bot(owner, key(), { id, name: id, department: 'desk', specialty: 'load' + b, method: 'test', contribution: 'Load fixture', budgetPaise: '3000000' });
      traders.push({ id: `trader-${b}`, role: 'trader', botId: id });
    }
    await f.db.transaction(tx => tx.query("UPDATE bots SET state='paper' WHERE id LIKE 'load-%'"));
    for (const symbol of ['AAA', 'BBB', 'CCC'])
      await f.paper.quote(market, key(), { symbol, bidPaise: '10000', askPaise: '10000', observedAt: new Date().toISOString(), sourceId: e.sourceId });
    const signals = new TradeSignals(f.db, f.cfg);
    const expires = new Date(Date.now() + 86_400_000).toISOString();

    const started = Date.now();
    const proposed = await Promise.all(traders.flatMap(trader => Array.from({ length: PER_BOT }, (_, i) =>
      signals.propose(trader, key(), { botId: trader.botId!, symbol: ['AAA', 'BBB', 'CCC'][i % 3], action: 'enter-long', horizonDays: 5,
        conviction: 'low', thesis: `Load call ${i}`, invalidation: 'Stop', expiresAt: expires, evidenceIds: [e.evidenceId], targetWeightPct: 5 })
        .then(r => ({ trader, id: r.id })))));
    const proposeMs = Date.now() - started;
    const reviews = await Promise.all(proposed.map(p => signals.review(evaluator, key(), { signalId: p.id })));
    const reviewMs = Date.now() - started - proposeMs;
    // every accepted signal executed twice at once: the second must resume, never trade again
    const accepted = proposed.filter((_, i) => reviews[i]!.outcome === 'accepted');
    const settled = await Promise.allSettled(accepted.flatMap(p => [signals.execute(p.trader, key(), { signalId: p.id }), signals.execute(p.trader, key(), { signalId: p.id })]));
    const totalMs = Date.now() - started;

    const rows = (await f.db.transaction(async tx => ({
      executions: Number((await tx.query('SELECT COUNT(*)::int AS n FROM trade_signal_executions')).rows[0]!.n),
      filledOrders: Number((await tx.query("SELECT COUNT(*)::int AS n FROM orders WHERE status='filled'")).rows[0]!.n),
      unbalanced: Number((await tx.query('SELECT COUNT(*)::int AS n FROM (SELECT journal_id FROM entries GROUP BY journal_id HAVING SUM(amount)<>0) x')).rows[0]!.n),
      w1: BigInt((await tx.query("SELECT COALESCE(SUM(amount),0)::text AS v FROM entries WHERE account='W1'")).rows[0]!.v),
      position: BigInt((await tx.query("SELECT COALESCE(SUM(amount),0)::text AS v FROM entries WHERE account='POSITION'")).rows[0]!.v),
      perBot: (await tx.query('SELECT bot_id,SUM(cost_paise)::text AS cost FROM positions GROUP BY bot_id')).rows,
    }), false));
    const operations = proposed.length * 2 + accepted.length * 2;
    t.diagnostic(`${proposed.length} proposals, ${accepted.length} accepted, ${rows.executions} executed in ${totalMs} ms ` +
      `(propose ${proposeMs} ms, review ${reviewMs} ms); ~${Math.round(operations / (totalMs / 1000))} serialised operations per second`);

    assert.equal(rows.executions, accepted.length);           // each accepted signal executed exactly once
    assert.equal(rows.filledOrders, accepted.length);         // ...and the duplicate attempts created no extra orders
    assert.ok(settled.every(s => s.status === 'fulfilled'));  // the duplicate calls resumed instead of failing
    assert.equal(rows.unbalanced, 0);
    assert.ok(rows.w1 >= 0n);
    assert.ok(rows.position <= f.cfg.maxExposure);
    for (const b of rows.perBot) assert.ok(BigInt(b.cost) <= 3_000_000n * 5n / 100n * 3n); // 5% target per share, 3 shares
    assert.equal((await f.ops.verifyAudit(owner)).valid, true);
    assert.ok(totalMs < 120_000, 'the trading path stays usable under this load');
  } finally { await f.db.close(); }
});
