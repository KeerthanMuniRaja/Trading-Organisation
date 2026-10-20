import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, owner, evaluator, trader, market, key } from './helpers.js';
import { TradeSignals } from '../src/trade-signals.js';

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

test('a liquidity cap fills only part of the reviewed size, never more, and replays safely', async () => {
  const f = await fixture(); try {
    const e = await f.evidence();
    await f.deposit('5000000');
    await f.org.bot(owner, key(), { id: 'bot-one', name: 'Fixture', department: 'desk', specialty: 'demo', method: 'test', contribution: 'Liquidity fixture', budgetPaise: '1000000' });
    await f.db.transaction(tx => tx.query("UPDATE bots SET state='paper' WHERE id='bot-one'"));
    await f.paper.quote(market, key(), { symbol: 'DEMO', bidPaise: '10000', askPaise: '10000', observedAt: new Date().toISOString(), sourceId: e.sourceId });
    const signals = new TradeSignals(f.db, f.cfg);
    const propose = async (thesis: string) => (await signals.propose(trader, key(), { botId: 'bot-one', symbol: 'DEMO', action: 'enter-long', horizonDays: 20,
      conviction: 'medium', thesis, invalidation: 'Fixture', expiresAt: inDays(2), evidenceIds: [e.evidenceId] })).id;
    const capped = await propose('Capped by volume');
    const reviewed = await signals.review(evaluator, key(), { signalId: capped });
    assert.ok(Number(reviewed.quantity) > 3, JSON.stringify(reviewed));
    const k = key();
    const done = await signals.execute(trader, k, { signalId: capped, maxQuantity: 3 });
    assert.equal(done.quantity, '3'); // a partial fill of the review
    assert.equal((await signals.execute(trader, k, { signalId: capped, maxQuantity: 3 })).duplicate, true); // a retry never trades twice
    const position = (await f.db.transaction(tx => tx.query("SELECT quantity::text AS q FROM positions WHERE bot_id='bot-one' AND symbol='DEMO'"))).rows[0]!;
    assert.equal(position.q, '3');
    // a cap larger than the review changes nothing: it can only shrink an order
    const uncapped = await propose('Cap above the review');
    const second = await signals.review(evaluator, key(), { signalId: uncapped });
    assert.equal((await signals.execute(trader, key(), { signalId: uncapped, maxQuantity: 1_000_000 })).quantity, String(second.quantity));
    await assert.rejects(() => signals.execute(trader, key(), { signalId: uncapped, maxQuantity: 0 }));
  } finally { await f.db.close(); }
});
