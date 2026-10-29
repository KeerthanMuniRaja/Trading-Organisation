import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, config, owner, researcher, evaluator, trader, market, key } from './helpers.js';
import { OwnerAlerts } from '../src/alerts.js';
import { journal } from '../src/treasury.js';
import { Database } from '../src/database.js';
import { createApp } from '../src/app.js';

test('conditions raise one alert each, stay deduplicated, escalate and resolve themselves', async () => {
  const f = await fixture(); try {
    const alerts = new OwnerAlerts(f.db, f.cfg);
    assert.deepEqual((await alerts.cycle(evaluator, key())).raised, []); // a healthy organisation raises nothing

    await f.db.transaction(tx => tx.query("UPDATE system_lock SET halted=true,halt_reason='Owner review' WHERE id=1"));
    // a realised loss of 80% of the 1000000-paise limit (fixture config)
    await f.deposit('1000000');
    await f.db.transaction(tx => journal(tx, 'paper-sell', 'loss:' + key(), {}, [['W1', -800000n], ['PNL', 800000n]]));
    await f.org.bot(owner, key(), { id: 'bot-one', name: 'bot-one', department: 'desk', specialty: 'one', method: 'test', contribution: 'Alert fixture', budgetPaise: '1000000' });
    await f.db.transaction(async tx => {
      for (const [ago, unrealised] of [[3, '0'], [2, '-150000'], [1, '-120000']] as const)
        await tx.query(`INSERT INTO paper_performance_snapshots(id,day,bot_id,budget_paise,realised_paise,unrealised_paise,open_positions,unpriced_or_stale,recorder)
          VALUES($1,CURRENT_DATE-$2::int,'bot-one',1000000,0,$3,1,0,'evaluator')`, [crypto.randomUUID(), ago, unrealised]);
    });
    const first = await alerts.cycle(evaluator, key());
    assert.deepEqual(first.raised.map(a => [a.rule, a.severity]).sort(), [['bot-drawdown', 'warning'], ['realised-loss-limit', 'warning'], ['system-halted', 'critical']]);
    assert.deepEqual((await alerts.cycle(evaluator, key())).raised, []); // still true: nothing new, no spam
    // an owner operating expense also debits PNL, but it is not a trading loss: no escalation from it
    await f.deposit('150000');
    await f.db.transaction(tx => journal(tx, 'operating-expense', 'expense:' + key(), {}, [['W1', -150000n], ['PNL', 150000n]]));
    assert.deepEqual((await alerts.cycle(evaluator, key())).raised, []);

    await f.db.transaction(tx => journal(tx, 'paper-sell', 'loss:' + key(), {}, [['W1', -200000n], ['PNL', 200000n]])); // now 100% of the limit
    await f.db.transaction(tx => tx.query("UPDATE system_lock SET halted=false,halt_reason=NULL WHERE id=1"));
    const second = await alerts.cycle(evaluator, key());
    assert.deepEqual(second.raised.map(a => [a.rule, a.severity]), [['realised-loss-limit', 'critical']]); // escalation is a new condition
    assert.equal(second.resolved, 2); // the halt cleared and the 'near' loss warning was superseded

    const view = await alerts.list(owner, {});
    assert.equal(view.open, 2);
    assert.equal(view.alerts[0]!.severity, 'critical'); // most severe first
    assert.equal(view.undelivered.length, 2);
    assert.equal((await alerts.delivered(evaluator, key(), { alertIds: view.undelivered })).delivered, 2);
    assert.equal((await alerts.list(owner, {})).undelivered.length, 0);
    await alerts.acknowledge(owner, key(), { alertIds: [view.alerts[0]!.id] });
    assert.ok((await alerts.list(owner, {})).alerts[0]!.acknowledgedAt);
    assert.throws(() => alerts.acknowledge(evaluator, key(), { alertIds: [view.alerts[0]!.id] })); // only the owner acknowledges
    const all = await alerts.list(owner, { includeResolved: true });
    assert.equal(all.alerts.length, 4);
    assert.equal((await f.ops.verifyAudit(owner)).valid, true);
  } finally { await f.db.close(); }
});

test('backlogs, stale position prices and pending owner decisions are surfaced', async () => {
  const f = await fixture(); try {
    const e = await f.evidence();
    await f.deposit('500000');
    await f.org.bot(owner, key(), { id: 'bot-one', name: 'bot-one', department: 'desk', specialty: 'one', method: 'test', contribution: 'Alert fixture', budgetPaise: '1000000' });
    await f.db.transaction(tx => tx.query("UPDATE bots SET state='paper' WHERE id='bot-one'"));
    await f.paper.quote(market, key(), { symbol: 'DEMO', bidPaise: '10000', askPaise: '10000', observedAt: new Date().toISOString(), sourceId: e.sourceId });
    const order = await f.paper.reserve(trader, key(), { botId: 'bot-one', symbol: 'DEMO', side: 'buy', quantity: 5, evidenceId: e.evidenceId });
    await f.paper.fill(trader, key(), { orderId: order.id });
    await f.db.transaction(tx => tx.query("UPDATE quotes SET observed_at=now()-interval '3 days'"));
    for (let i = 0; i < 20; i++)
      await f.org.evidence(researcher, key(), { sourceId: e.sourceId, kind: 'dataset', content: 'Waiting note ' + i + key(), publishedAt: '2025-01-01T00:00:00Z' });
    // two days old: still inside the fact-checker's hold period, so not a backlog
    await f.db.transaction(tx => tx.query("UPDATE evidence SET received_at=now()-interval '2 days' WHERE status='unverified'"));
    const raised = (await new OwnerAlerts(f.db, f.cfg).cycle(owner, key())).raised.map(a => a.rule).sort();
    assert.deepEqual(raised, ['stale-position-prices']);
    await f.db.transaction(tx => tx.query("UPDATE evidence SET received_at=now()-interval '9 days' WHERE status='unverified'"));
    const later = (await new OwnerAlerts(f.db, f.cfg).cycle(owner, key())).raised;
    assert.deepEqual(later.map(a => a.rule), ['evidence-backlog']);
  } finally { await f.db.close(); }
});

test('alert routes are owner and evaluator only', async () => {
  const { cfg } = config(), db = await Database.open(), app = await createApp(cfg, db, true);
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const post = (path: string, role: string, body: unknown = {}) => fetch(base + '/v1' + path, { method: 'POST', body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key(), Authorization: 'Bearer ' + cfg.principals.find(p => p.role === role)!.token } });
    assert.equal((await post('/alerts/cycles', 'evaluator')).status, 201);
    assert.equal((await post('/alerts/query', 'trader')).status, 403);
    assert.equal((await post('/alerts/acknowledgments', 'evaluator', { alertIds: [crypto.randomUUID()] })).status, 403);
  } finally { await app.close(); await db.close(); }
});
