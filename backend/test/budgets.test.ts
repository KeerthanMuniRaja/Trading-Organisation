import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, owner, researcher, evaluator, key } from './helpers.js';
import { BotControl } from '../src/bot-control.js';
import { ComputeUsage } from '../src/compute-usage.js';

const says = (pattern: RegExp) => (error: any) => pattern.test(JSON.stringify(error?.getResponse?.() ?? error?.message));
const today = new Date().toISOString().slice(0, 10);

test('a department ceiling is enforced on new bots and budget raises, while lowering always works', async () => {
  const f = await fixture(); try {
    await f.db.transaction(tx => tx.query("INSERT INTO departments(id,name,mandate,budget_paise,status) VALUES('desk','Desk','Trade the shares',1000000,'active')"));
    const bot = (id: string, budgetPaise: string) => f.org.bot(owner, key(), { id, name: id, department: 'desk', specialty: id, method: 'rules', contribution: 'Ceiling fixture', budgetPaise });
    await bot('one', '600000');
    await assert.rejects(() => bot('two', '500000'), says(/ceiling is 1000000 paise and its other members hold 600000; .*at most 400000/));
    await bot('two', '400000'); // exactly at the ceiling
    const control = new BotControl(f.db);
    await assert.rejects(() => control.budget(owner, key(), { botId: 'two', budgetPaise: '400100', reason: 'more' }), says(/ceiling/));
    await control.budget(owner, key(), { botId: 'one', budgetPaise: '500000', reason: 'smaller' }); // lowering is always allowed
    await control.budget(owner, key(), { botId: 'two', budgetPaise: '500000', reason: 'room freed' });
    // a label that is not a registered active department has no ceiling
    await f.org.bot(owner, key(), { id: 'free', name: 'free', department: 'unregistered', specialty: 'x', method: 'y', contribution: 'No ceiling', budgetPaise: '99000000' });
    await f.db.transaction(tx => tx.query("UPDATE departments SET status='closed',closed_at=now() WHERE id='desk'"));
    await control.budget(owner, key(), { botId: 'two', budgetPaise: '900000', reason: 'closed department: no ceiling applies' });
  } finally { await f.db.close(); }
});

test('the compute allowance says no once the department used its daily tokens', async () => {
  const f = await fixture(); try {
    await f.db.transaction(tx => tx.query("INSERT INTO departments(id,name,mandate,budget_paise,status,compute_tokens_per_day) VALUES('portfolio','Portfolio','Allocate',0,'active',5000)"));
    await f.org.bot(owner, key(), { id: 'allocator', name: 'Allocator', department: 'portfolio', specialty: 'alloc', method: 'llm', contribution: 'Compute fixture', budgetPaise: '0' });
    await f.org.bot(owner, key(), { id: 'free-bot', name: 'Free', department: 'elsewhere', specialty: 'x', method: 'y', contribution: 'Unlimited', budgetPaise: '0' });
    const compute = new ComputeUsage(f.db);
    assert.equal((await compute.allowance(evaluator, { botId: 'allocator' })).allowed, true);
    const report = (tokens: number) => compute.report(researcher, key(), { botId: 'allocator', model: 'm', runLabel: 'run-' + tokens, periodFrom: today, periodTo: today,
      calls: 1, promptTokens: tokens, completionTokens: 0, latencyMs: 10 });
    await report(4000);
    assert.deepEqual(await compute.allowance(evaluator, { botId: 'allocator' }),
      { botId: 'allocator', departmentId: 'portfolio', budgetTokensPerDay: 5000, usedTodayTokens: '4000', allowed: true });
    await report(1000);
    assert.equal((await compute.allowance(evaluator, { botId: 'allocator' })).allowed, false); // used up for today
    assert.equal((await compute.allowance(researcher, { botId: 'free-bot' })).allowed, true); // no budget set: not limited
    await assert.rejects(() => compute.allowance(evaluator, { botId: 'nobody' }), says(/Bot not found/));
  } finally { await f.db.close(); }
});
