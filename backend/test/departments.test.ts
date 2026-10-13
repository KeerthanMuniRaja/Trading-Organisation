import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, config, owner, researcher, evaluator, trader, market, key } from './helpers.js';
import { Departments } from '../src/departments.js';
import { Database } from '../src/database.js';
import { createApp } from '../src/app.js';

const says = (pattern: RegExp) => (error: any) => pattern.test(JSON.stringify(error?.getResponse?.() ?? error?.message));

async function setup() {
  const f = await fixture();
  const e = await f.evidence();
  const bot = (id: string, department: string, budgetPaise: string) => f.org.bot(owner, key(), { id, name: id, department, specialty: id,
    method: 'test', contribution: 'Department fixture ' + id, budgetPaise });
  await bot('bot-one', 'desk', '600000');
  await bot('bot-two', 'desk', '600000');
  await bot('scout', 'research', '0');
  const open = { kind: 'open', departmentId: 'desk', name: 'Trading desk', mandate: 'Intraday paper trading of NSE large caps',
    rationale: 'Two qualified traders already share this work', evidenceIds: [e.evidenceId] };
  return { ...f, e, departments: new Departments(f.db), open };
}

test('bots propose departments with evidence; only the owner opens them, sets the budget and appoints the lead', async () => {
  const f = await setup(); try {
    assert.throws(() => f.departments.propose(trader, key(), f.open)); // traders do not shape the organisation
    assert.throws(() => f.departments.propose(owner, key(), f.open)); // the owner decides rather than proposes
    const unverified = await f.org.evidence(researcher, key(), { sourceId: f.e.sourceId, kind: 'dataset', content: 'Unreviewed ' + key(), publishedAt: '2025-01-01T00:00:00Z' });
    await assert.rejects(() => f.departments.propose(researcher, key(), { ...f.open, evidenceIds: [unverified.id] }), says(/verified/));
    const proposal = await f.departments.propose(researcher, key(), f.open);
    assert.equal((await f.departments.propose(researcher, key(), f.open)).duplicate, true);
    assert.throws(() => f.departments.decide(evaluator, key(), { proposalId: proposal.id, outcome: 'approved', budgetPaise: '1000000', note: 'ok' }));
    await assert.rejects(() => f.departments.decide(owner, key(), { proposalId: proposal.id, outcome: 'approved', note: 'no budget' }), says(/budget ceiling/));
    await f.departments.decide(owner, key(), { proposalId: proposal.id, outcome: 'approved', budgetPaise: '1000000', note: 'Approved for paper trading' });
    await assert.rejects(() => f.departments.decide(owner, key(), { proposalId: proposal.id, outcome: 'rejected', note: 'again' }), says(/already decided/));
    await assert.rejects(() => f.departments.appointLead(owner, key(), { departmentId: 'desk', leadBotId: 'scout' }), says(/member/));
    await f.departments.appointLead(owner, key(), { departmentId: 'desk', leadBotId: 'bot-one' });

    const view = await f.departments.registry(owner);
    const desk = view.departments.find(d => d.id === 'desk')!;
    assert.deepEqual([desk.status, desk.leadBotId, desk.members.map(m => m.botId)], ['active', 'bot-one', ['bot-one', 'bot-two']]);
    assert.deepEqual([desk.allocatedToMembersPaise, desk.overBudget], ['1200000', true]); // members' budgets exceed the ceiling: flagged
    assert.deepEqual(view.unregisteredLabels, ['research']);
    assert.equal(view.pendingProposals.length, 0);
    await assert.rejects(() => f.departments.propose(researcher, key(), { ...f.open, rationale: 'Again' }), says(/already active/));
    await assert.rejects(() => f.db.transaction(tx => tx.query("UPDATE department_decisions SET outcome='rejected'")));
  } finally { await f.db.close(); }
});

test('a department closes only when its members hold no paper risk', async () => {
  const f = await setup(); try {
    await f.departments.decide(owner, key(), { proposalId: (await f.departments.propose(researcher, key(), f.open)).id, outcome: 'approved',
      budgetPaise: '1200000', note: 'Open' });
    await f.deposit('500000');
    await f.db.transaction(tx => tx.query("UPDATE bots SET state='paper' WHERE id='bot-one'"));
    await f.paper.quote(market, key(), { symbol: 'DEMO', bidPaise: '10000', askPaise: '10000', observedAt: new Date().toISOString(), sourceId: f.e.sourceId });
    const order = await f.paper.reserve(trader, key(), { botId: 'bot-one', symbol: 'DEMO', side: 'buy', quantity: 5, evidenceId: f.e.evidenceId });
    await f.paper.fill(trader, key(), { orderId: order.id });
    const close = { kind: 'close', departmentId: 'desk', rationale: 'Six months without beating the basket', evidenceIds: [f.e.evidenceId] };
    const first = await f.departments.propose(evaluator, key(), close);
    await assert.rejects(() => f.departments.decide(owner, key(), { proposalId: first.id, outcome: 'approved', note: 'Close' }), says(/bot-one/));
    const exit = await f.paper.reserve(trader, key(), { botId: 'bot-one', symbol: 'DEMO', side: 'sell', quantity: 5, evidenceId: f.e.evidenceId });
    await f.paper.fill(trader, key(), { orderId: exit.id });
    await f.departments.decide(owner, key(), { proposalId: first.id, outcome: 'approved', note: 'Closed after exits' });
    const desk = (await f.departments.registry(owner)).departments.find(d => d.id === 'desk')!;
    assert.deepEqual([desk.status, desk.leadBotId, desk.overBudget], ['closed', null, false]);
    assert.ok(desk.closedAt);
    // a closed department can be proposed and approved again, with a fresh charter
    const reopen = await f.departments.propose(researcher, key(), { ...f.open, mandate: 'Daily-horizon paper trading', rationale: 'New evidence' });
    await f.departments.decide(owner, key(), { proposalId: reopen.id, outcome: 'approved', budgetPaise: '1300000', note: 'Reopened' });
    const again = (await f.departments.registry(owner)).departments.find(d => d.id === 'desk')!;
    assert.deepEqual([again.status, again.mandate, again.budgetPaise], ['active', 'Daily-horizon paper trading', '1300000']);
    assert.equal((await f.ops.verifyAudit(owner)).valid, true);
  } finally { await f.db.close(); }
});

test('department routes are registered and guarded by role', async () => {
  const { cfg } = config(), db = await Database.open(), app = await createApp(cfg, db, true);
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const token = (role: string) => 'Bearer ' + cfg.principals.find(p => p.role === role)!.token;
    assert.equal((await fetch(base + '/v1/departments', { headers: { Authorization: token('researcher') } })).status, 200);
    assert.equal((await fetch(base + '/v1/departments', { headers: { Authorization: token('trader') } })).status, 403);
    const post = (path: string, role: string) => fetch(base + '/v1' + path, { method: 'POST', body: '{}',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key(), Authorization: token(role) } });
    assert.equal((await post('/departments/decisions', 'researcher')).status, 403);
    assert.equal((await post('/departments/proposals', 'trader')).status, 403);
  } finally { await app.close(); await db.close(); }
});
