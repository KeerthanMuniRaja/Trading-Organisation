import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, config, owner, researcher, evaluator, trader, market, key } from './helpers.js';
import { BotControl } from '../src/bot-control.js';
import { TradeSignals } from '../src/trade-signals.js';
import { Database } from '../src/database.js';
import { createApp } from '../src/app.js';

const says = (pattern: RegExp) => (error: any) => pattern.test(JSON.stringify(error?.getResponse?.() ?? error?.message));
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

async function setup() {
  const f = await fixture();
  const e = await f.evidence();
  await f.deposit('500000');
  await f.org.bot(owner, key(), { id: 'bot-one', name: 'Fixture', department: 'desk', specialty: 'demo', method: 'test', contribution: 'Control fixture', budgetPaise: '1000000' });
  await f.db.transaction(tx => tx.query("UPDATE bots SET state='paper' WHERE id='bot-one'"));
  await f.paper.quote(market, key(), { symbol: 'DEMO', bidPaise: '10000', askPaise: '10000', observedAt: new Date().toISOString(), sourceId: e.sourceId });
  const long = { botId: 'bot-one', symbol: 'DEMO', action: 'enter-long', horizonDays: 20, conviction: 'medium', thesis: 'Fixture long',
    invalidation: 'Fixture', expiresAt: inDays(2), evidenceIds: [e.evidenceId] };
  return { ...f, e, long, signals: new TradeSignals(f.db, f.cfg), control: new BotControl(f.db) };
}

test('a suspended bot takes no new risk but may still reduce it, until the owner resumes it', async () => {
  const f = await setup(); try {
    const held = await f.signals.propose(trader, key(), f.long);
    await f.signals.execute(trader, key(), { signalId: (await f.signals.review(evaluator, key(), { signalId: held.id }), held.id) });
    const before = await f.signals.propose(trader, key(), { ...f.long, thesis: 'Proposed before the suspension' });

    assert.throws(() => f.control.suspend(trader, key(), { botId: 'bot-one', suspended: true, reason: 'x' }));
    await f.control.suspend(owner, key(), { botId: 'bot-one', suspended: true, reason: 'Live calls worse than cash' });
    await assert.rejects(() => f.control.suspend(owner, key(), { botId: 'bot-one', suspended: true, reason: 'again' }), says(/already suspended/));
    await assert.rejects(() => f.signals.propose(trader, key(), { ...f.long, thesis: 'New risk' }), says(/suspended/));
    assert.ok((await f.signals.review(evaluator, key(), { signalId: before.id })).reasons.includes('bot-suspended')); // rejected at review
    await assert.rejects(() => f.paper.reserve(trader, key(), { botId: 'bot-one', symbol: 'DEMO', side: 'buy', quantity: 1, evidenceId: f.e.evidenceId }), says(/suspended/));
    // reducing risk stays possible: an exit is proposed, accepted and executed
    const exit = await f.signals.propose(trader, key(), { ...f.long, action: 'exit', thesis: 'Reduce risk while suspended' });
    assert.equal((await f.signals.review(evaluator, key(), { signalId: exit.id })).outcome, 'accepted');
    assert.equal((await f.signals.execute(trader, key(), { signalId: exit.id })).side, 'sell');

    await f.control.suspend(owner, key(), { botId: 'bot-one', suspended: false, reason: 'Reviewed and fixed' });
    assert.ok((await f.signals.propose(trader, key(), { ...f.long, thesis: 'Back to work' })).id);
    await assert.rejects(() => f.db.transaction(tx => tx.query('DELETE FROM bot_suspensions')));
    assert.equal((await f.ops.verifyAudit(owner)).valid, true);
  } finally { await f.db.close(); }
});

test('the owner changes a bot\'s budget, with an append-only record of every change', async () => {
  const f = await setup(); try {
    const changed = await f.control.budget(owner, key(), { botId: 'bot-one', budgetPaise: '300000', reason: 'Smaller while on trial' });
    assert.deepEqual([changed.budgetBeforePaise, changed.budgetPaise], ['1000000', '300000']);
    assert.equal((await f.db.transaction(tx => tx.query("SELECT budget_paise::text AS b FROM bots WHERE id='bot-one'"))).rows[0]!.b, '300000');
    await assert.rejects(() => f.control.budget(owner, key(), { botId: 'bot-one', budgetPaise: '300000', reason: 'same' }), says(/already that amount/));
    assert.throws(() => f.control.budget(researcher, key(), { botId: 'bot-one', budgetPaise: '1', reason: 'x' }));
    assert.equal((await f.db.transaction(tx => tx.query('SELECT count(*)::int AS n FROM bot_budget_changes'))).rows[0]!.n, 1);
  } finally { await f.db.close(); }
});

test('a bot with nothing learned may retire without a transfer, but never with open proposals or untransferred knowledge', async () => {
  const f = await setup(); try {
    const open = await f.signals.propose(trader, key(), f.long);
    await assert.rejects(() => f.org.retire(owner, key(), { botId: 'bot-one', reason: 'Rule bot no longer needed' }), says(/open trade proposals/));
    await f.signals.review(evaluator, key(), { signalId: open.id }); // accepted but still open
    await assert.rejects(() => f.org.retire(owner, key(), { botId: 'bot-one', reason: 'Rule bot no longer needed' }), says(/open trade proposals/));
    await f.db.transaction(tx => tx.query("INSERT INTO trade_signal_lapses(signal_id,released_paise,recorded_by) VALUES($1,0,'evaluator')", [open.id]));
    assert.equal((await f.org.retire(owner, key(), { botId: 'bot-one', reason: 'Rule bot no longer needed' })).knowledgePreserved, false);

    await f.org.bot(owner, key(), { id: 'learner', name: 'Learner', department: 'desk', specialty: 'learn', method: 'llm', contribution: 'Learned something', budgetPaise: '0' });
    const lesson = await f.org.lesson(researcher, key(), { botId: 'learner', content: 'A verified lesson', evidenceId: f.e.evidenceId });
    await f.org.verifyLesson(evaluator, key(), { lessonId: lesson.id });
    await assert.rejects(() => f.org.retire(owner, key(), { botId: 'learner', reason: 'Done' }), says(/transfer at least one/));
    assert.equal((await f.org.retire(owner, key(), { botId: 'learner', reason: 'Done', transferLessonIds: [lesson.id] })).knowledgePreserved, true);
  } finally { await f.db.close(); }
});

test('bot control routes are owner only', async () => {
  const { cfg } = config(), db = await Database.open(), app = await createApp(cfg, db, true);
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const post = (path: string, role: string) => fetch(base + '/v1/bots/' + path, { method: 'POST', body: '{}',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key(), Authorization: 'Bearer ' + cfg.principals.find(p => p.role === role)!.token } });
    assert.equal((await post('suspensions', 'evaluator')).status, 403);
    assert.equal((await post('budgets', 'trader')).status, 403);
  } finally { await app.close(); await db.close(); }
});
