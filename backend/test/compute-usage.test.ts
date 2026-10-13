import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, config, owner, researcher, evaluator, trader, key } from './helpers.js';
import { ComputeUsage } from '../src/compute-usage.js';
import { Departments } from '../src/departments.js';
import { OwnerAlerts } from '../src/alerts.js';
import { Database } from '../src/database.js';
import { createApp } from '../src/app.js';

const today = () => new Date().toISOString().slice(0, 10);

test('usage is reported per bot, rolled up by department, compared with an owner budget and alerted', async () => {
  const f = await fixture(); try {
    const e = await f.evidence();
    for (const [id, department] of [['trend', 'desk'], ['reversion', 'desk'], ['scout', 'research']])
      await f.org.bot(owner, key(), { id, name: id, department, specialty: id, method: 'test', contribution: 'Compute fixture ' + id, budgetPaise: '0' });
    const depts = new Departments(f.db);
    const proposal = await depts.propose(researcher, key(), { kind: 'open', departmentId: 'desk', name: 'Desk', mandate: 'Paper trading',
      rationale: 'Two bots share the work', evidenceIds: [e.evidenceId] });
    await depts.decide(owner, key(), { proposalId: proposal.id, outcome: 'approved', budgetPaise: '0', note: 'Open' });
    const compute = new ComputeUsage(f.db);
    const run = { model: 'Qwen3.5-4B-Q4_K_M', periodFrom: today(), periodTo: today(), calls: 10, latencyMs: 450000 };
    await compute.report(researcher, key(), { ...run, botId: 'trend', runLabel: 'desk batch w1', promptTokens: 9000, completionTokens: 1000 });
    assert.equal((await compute.report(researcher, key(), { ...run, botId: 'trend', runLabel: 'desk batch w1', promptTokens: 9000, completionTokens: 1000 })).duplicate, true);
    await compute.report(evaluator, key(), { ...run, botId: 'reversion', runLabel: 'desk batch w1', promptTokens: 4000, completionTokens: 1000 });
    await compute.report(researcher, key(), { ...run, botId: 'scout', runLabel: 'claims run', promptTokens: 2000, completionTokens: 500 });
    assert.throws(() => compute.report(trader, key(), { ...run, botId: 'trend', runLabel: 'x', promptTokens: 1, completionTokens: 1 }));
    assert.throws(() => compute.report(researcher, key(), { ...run, botId: 'trend', runLabel: 'future', promptTokens: 1, completionTokens: 1,
      periodFrom: '2099-01-01', periodTo: '2099-01-01' })); // refused before touching the database

    const usage = await compute.usage(owner, { days: 1 });
    const desk = usage.departments.find(d => d.departmentId === 'desk')!;
    assert.deepEqual([desk.tokens, desk.calls, desk.bots], ['15000', '20', ['reversion', 'trend']]);
    assert.equal(usage.bots.find(b => b.botId === 'trend')!.averageLatencyMs, 45000);
    assert.equal(desk.overBudget, false); // no budget set yet

    assert.throws(() => compute.setBudget(evaluator, key(), { departmentId: 'desk', tokensPerDay: 10000 }));
    await compute.setBudget(owner, key(), { departmentId: 'desk', tokensPerDay: 10000 });
    assert.equal((await compute.usage(owner, { days: 1 })).departments.find(d => d.departmentId === 'desk')!.overBudget, true);
    const raised = (await new OwnerAlerts(f.db, f.cfg).cycle(evaluator, key())).raised;
    assert.deepEqual(raised.map(a => [a.rule, a.subject]), [['compute-over-budget', 'desk']]);
    await compute.setBudget(owner, key(), { departmentId: 'desk', tokensPerDay: null });
    assert.equal((await new OwnerAlerts(f.db, f.cfg).cycle(evaluator, key())).resolved, 1); // budget removed: the alert resolves
    await assert.rejects(() => f.db.transaction(tx => tx.query('UPDATE compute_usage SET calls=1')));
  } finally { await f.db.close(); }
});

test('compute routes are guarded by role', async () => {
  const { cfg } = config(), db = await Database.open(), app = await createApp(cfg, db, true);
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const post = (path: string, role: string, body: unknown = {}) => fetch(base + '/v1' + path, { method: 'POST', body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key(), Authorization: 'Bearer ' + cfg.principals.find(p => p.role === role)!.token } });
    assert.equal((await post('/compute/usage', 'evaluator')).status, 201);
    assert.equal((await post('/compute/usage', 'trader')).status, 403);
    assert.equal((await post('/compute/budgets', 'researcher', { departmentId: 'desk', tokensPerDay: 5000 })).status, 403);
  } finally { await app.close(); await db.close(); }
});
