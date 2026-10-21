import test from 'node:test';
import assert from 'node:assert/strict';
import { owner, trader, evaluator, market, fixture, key } from './helpers.js';
import { OwnerDigest } from '../src/owner-digest.js';

test('a refused order is kept after its rollback, once per request, and the answer does not change', async () => {
  const f = await fixture();
  try {
    const e = await f.evidence(); await f.deposit('150000');
    await f.org.bot(owner, key(), { id: 'bot-one', name: 'Fixture', department: 'research', specialty: 'demo', method: 'test', contribution: 'Refusal fixture', budgetPaise: '1000000' });
    await f.db.transaction(tx => tx.query("UPDATE bots SET state='paper' WHERE id='bot-one'"));
    await f.paper.quote(market, key(), { symbol: 'DEMO', bidPaise: '10000', askPaise: '10000', observedAt: new Date().toISOString(), sourceId: e.sourceId });
    const buy = { botId: 'bot-one', symbol: 'DEMO', side: 'buy', quantity: 1, evidenceId: e.evidenceId };

    // a successful order leaves no refusal
    const ok = await f.paper.reserve(trader, key(), buy);
    await f.paper.fill(trader, key(), { orderId: ok.id });
    assert.equal((await f.paper.refusals(owner, {})).refusals.length, 0);

    // halted: the same error as before, and one row; a retry with the same key is not recorded twice
    await f.db.transaction(tx => tx.query('UPDATE system_lock SET halted=true WHERE id=1'));
    const k = key();
    await assert.rejects(() => f.paper.reserve(trader, k, buy), /New risk is halted/);
    await assert.rejects(() => f.paper.reserve(trader, k, buy), /New risk is halted/);
    assert.equal((await f.db.transaction(tx => tx.query("SELECT COUNT(*)::int AS n FROM orders WHERE status='reserved'"), false)).rows[0]!.n, 0); // still rolled back
    let r = (await f.paper.refusals(owner, {})).refusals;
    assert.equal(r.length, 1);
    assert.deepEqual({ stage: r[0]!.stage, botId: r[0]!.botId, symbol: r[0]!.symbol, side: r[0]!.side, quantity: r[0]!.quantity, status: r[0]!.status, message: r[0]!.message },
      { stage: 'reserve', botId: 'bot-one', symbol: 'DEMO', side: 'buy', quantity: '1', status: 409, message: 'New risk is halted' });
    await f.db.transaction(tx => tx.query('UPDATE system_lock SET halted=false WHERE id=1'));

    // a fill refused for a missing order, and one refused for an order already filled: the order's details come with it
    const ghost = '00000000-0000-4000-8000-000000000000';
    await assert.rejects(() => f.paper.fill(trader, key(), { orderId: ghost }), /Order not found/);
    await assert.rejects(() => f.paper.fill(trader, key(), { orderId: ok.id }), /Order is not reserved/);
    r = (await f.paper.refusals(owner, {})).refusals;
    assert.deepEqual(r.map(x => [x.stage, x.status, x.orderId, x.symbol]).sort(), [['fill', 404, ghost, null], ['fill', 409, ok.id, 'DEMO'], ['reserve', 409, null, 'DEMO']]);

    // malformed requests are not refusals: a bad key, a bad body, the wrong role
    await assert.rejects(() => f.paper.reserve(trader, 'bad', buy), /Idempotency-Key/);
    assert.throws(() => f.paper.reserve(trader, key(), { ...buy, quantity: 0 }));
    assert.equal((await f.paper.refusals(owner, {})).refusals.length, 3);

    // filters, roles, and append-only history
    assert.equal((await f.paper.refusals(evaluator, { botId: 'nobody' })).refusals.length, 0);
    assert.throws(() => f.paper.refusals(trader, {}));
    await assert.rejects(() => f.db.transaction(tx => tx.query("UPDATE order_refusals SET message='x'")));

    // the digest counts them, and shows the limits this backend loaded
    const d = await new OwnerDigest(f.db, f.cfg).digest(owner, {});
    assert.equal(d.trading.refusedOrders, 3);
    assert.deepEqual(d.trading.topRefusals.map(x => x.count), [1, 1, 1]);
    assert.deepEqual(d.limits, { maxOrderPaise: f.cfg.maxOrder.toString(), maxExposurePaise: f.cfg.maxExposure.toString(), maxRealisedLossPaise: f.cfg.maxLoss.toString(),
      feeBps: f.cfg.feeBps, slippageBps: f.cfg.slippageBps, realisedLossPaise: '0', lossLimitUsedPct: 0 });
    assert.equal((await new OwnerDigest(f.db).digest(owner, {})).limits, null); // older wiring: no config, no banner
  } finally { await f.db.close(); }
});
