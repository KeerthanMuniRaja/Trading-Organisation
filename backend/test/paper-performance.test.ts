import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, config, owner, evaluator, researcher, trader, market, key } from './helpers.js';
import { PaperPerformance, curveStats, indiaDay } from '../src/paper-performance.js';
import { Database } from '../src/database.js';
import { createApp } from '../src/app.js';

test('per-bot profit and loss comes from the ledger and open positions are marked at the latest bid', async () => {
  const f = await fixture(); try {
    const e = await f.evidence();
    await f.deposit('500000');
    for (const id of ['bot-one', 'bot-two']) {
      await f.org.bot(owner, key(), { id, name: id, department: 'desk', specialty: id, method: 'test', contribution: 'Performance fixture', budgetPaise: '1000000' });
      await f.db.transaction(tx => tx.query("UPDATE bots SET state='paper' WHERE id=$1", [id]));
    }
    let tick = 0;
    const quote = (bid: string) => f.paper.quote(market, key(), { symbol: 'DEMO', bidPaise: bid, askPaise: bid,
      observedAt: new Date(Date.now() + 1000 * ++tick).toISOString(), sourceId: e.sourceId });
    const trade = async (side: 'buy' | 'sell', quantity: number) => {
      const order = await f.paper.reserve(trader, key(), { botId: 'bot-one', symbol: 'DEMO', side, quantity, evidenceId: e.evidenceId });
      await f.paper.fill(trader, key(), { orderId: order.id });
    };
    await quote('10000'); await trade('buy', 10);   // cost 100000
    await quote('11000'); await trade('sell', 5);   // proceeds 55000 against cost 50000: +5000 realised
    await quote('12000');                           // 5 left, cost 50000, marked at 60000: +10000 unrealised

    const report = await new PaperPerformance(f.db).report(owner);
    const one = report.bots.find(b => b.botId === 'bot-one')!;
    assert.deepEqual([one.realisedPaise, one.unrealisedPaise, one.totalPaise], ['5000', '10000', '15000']);
    assert.equal(one.returnOnBudgetPct, 1.5);
    assert.deepEqual([one.fills, one.closingTrades, one.winningClosingTrades, one.budgetUsedPaise], [2, 1, 1, '50000']);
    assert.deepEqual(one.openPositions.map(p => [p.symbol, p.quantity, p.marketValuePaise, p.valuation]), [['DEMO', '5', '60000', 'latest-approved-bid']]);
    const two = report.bots.find(b => b.botId === 'bot-two')!;
    assert.deepEqual([two.totalPaise, two.fills, two.openPositions.length], ['0', 0, 0]);
    assert.equal(report.organisation!.totalPaise, '15000');

    const own = await new PaperPerformance(f.db).report(trader); // a trader sees only its own bot, without organisation totals
    assert.deepEqual(own.bots.map(b => b.botId), ['bot-one']);
    assert.equal(own.organisation, null);
  } finally { await f.db.close(); }
});

test('equity statistics: total return and worst peak-to-trough fall', () => {
  assert.deepEqual(curveStats([100n, 110n, 99n, 120n]), { returnPct: 20, maxDrawdownPct: 10 }); // fell 11 from a 110 peak
  assert.deepEqual(curveStats([100n, 100n]), { returnPct: 0, maxDrawdownPct: 0 });
  assert.deepEqual(curveStats([]), { returnPct: null, maxDrawdownPct: null });
  assert.equal(indiaDay(Date.parse('2026-10-12T19:00:00Z')), '2026-10-13'); // 00:30 IST is already the next trading day
});

test('daily snapshots are recorded once per day, append-only, and build each bot\'s equity curve', async () => {
  const f = await fixture(); try {
    const e = await f.evidence();
    await f.deposit('500000');
    await f.org.bot(owner, key(), { id: 'bot-one', name: 'bot-one', department: 'desk', specialty: 'one', method: 'test', contribution: 'Snapshot fixture', budgetPaise: '1000000' });
    await f.db.transaction(tx => tx.query("UPDATE bots SET state='paper' WHERE id='bot-one'"));
    await f.paper.quote(market, key(), { symbol: 'DEMO', bidPaise: '10000', askPaise: '10000', observedAt: new Date().toISOString(), sourceId: e.sourceId });
    const order = await f.paper.reserve(trader, key(), { botId: 'bot-one', symbol: 'DEMO', side: 'buy', quantity: 10, evidenceId: e.evidenceId });
    await f.paper.fill(trader, key(), { orderId: order.id });
    // two earlier days, as a nightly job would have recorded them
    await f.db.transaction(async tx => {
      for (const [ago, unrealised] of [[2, '30000'], [1, '-60000']] as const)
        await tx.query(`INSERT INTO paper_performance_snapshots(id,day,bot_id,budget_paise,realised_paise,unrealised_paise,open_positions,unpriced_or_stale,recorder)
          VALUES($1,CURRENT_DATE-$2::int,'bot-one',1000000,0,$3,1,0,'evaluator')`, [crypto.randomUUID(), ago, unrealised]);
    });
    const perf = new PaperPerformance(f.db);
    assert.throws(() => perf.snapshot(trader, key())); // traders cannot write history
    const today = await perf.snapshot(evaluator, key());
    assert.deepEqual([today.recorded, today.alreadyRecorded], [1, 0]);
    assert.deepEqual([(await perf.snapshot(evaluator, key())).recorded], [0]); // the first mark of the day stands
    await assert.rejects(() => f.db.transaction(tx => tx.query('UPDATE paper_performance_snapshots SET unrealised_paise=0')));
    const history = await perf.history(owner, {});
    const curve = history.bots[0]!;
    assert.equal(curve.days, 3);
    assert.deepEqual(curve.curve.map(c => c.equityPaise), ['1030000', '940000', '1000000']); // today: bought at the mark, flat
    assert.equal(curve.returnPct, -2.9126); // 1030000 -> 1000000
    assert.equal(curve.maxDrawdownPct, 8.7378); // 1030000 -> 940000
    assert.deepEqual((await perf.history(trader, { botId: 'someone-else' })).bots.map(b => b.botId), ['bot-one']); // traders see only their own
    assert.throws(() => perf.history(researcher, {}));
    assert.equal((await f.ops.verifyAudit(owner)).valid, true);
  } finally { await f.db.close(); }
});

test('the performance route is read-only and guarded by role', async () => {
  const { cfg } = config(), db = await Database.open(), app = await createApp(cfg, db, true);
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const get = (role: string) => fetch(base + '/v1/paper/performance', { headers: { Authorization: 'Bearer ' + cfg.principals.find(p => p.role === role)!.token } });
    assert.equal((await get('owner')).status, 200);
    assert.equal((await get('trader')).status, 200);
    assert.equal((await get('researcher')).status, 403);
  } finally { await app.close(); await db.close(); }
});
