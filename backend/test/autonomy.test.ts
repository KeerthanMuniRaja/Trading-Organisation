import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, config, owner, researcher, evaluator, key } from './helpers.js';
import { Autonomy } from '../src/autonomy.js';
import { Management } from '../src/management.js';
import { BotFitness } from '../src/bot-fitness.js';
import { BotReleases } from '../src/bot-releases.js';
import { BotBirths } from '../src/bot-births.js';
import { isSuspended } from '../src/bot-control.js';
import { Database } from '../src/database.js';
import { createApp } from '../src/app.js';

const says = (pattern: RegExp) => (error: any) => pattern.test(JSON.stringify(error?.getResponse?.() ?? error?.message));
const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const OFF = { suspendOnRecommendation: false, acknowledgeWatch: false, raiseBudget: null, approveBirths: false, activateReleases: false,
  qualifyBots: false, startingBudgetPaise: null, maxActionsPerRun: 10 };

async function setup() {
  const f = await fixture();
  await f.org.bot(owner, key(), { id: 'bot-one', name: 'Worker', department: 'desk', specialty: 'demo', method: 'test', contribution: 'Autonomy fixture', budgetPaise: '500000' });
  await f.db.transaction(tx => tx.query("UPDATE bots SET state='paper' WHERE id='bot-one'"));
  return { ...f, autonomy: new Autonomy(f.db, f.cfg), management: new Management(f.db, f.cfg), fitness: new BotFitness(f.db), releases: new BotReleases(f.db) };
}
const recommend = (f: Awaited<ReturnType<typeof setup>>, kind: string, budget: string | null) => f.db.transaction(async tx => {
  const id = randomUUID();
  await tx.query(`INSERT INTO bot_recommendations(id,bot_id,kind,rule,reason,proposed_budget_paise,facts,proposer,content_hash)
    VALUES($1,'bot-one',$2,'test','Fixture recommendation',$3,'{}'::jsonb,'evaluator',$4)`, [id, kind, budget, randomUUID()]);
  return id;
});
const decidedBy = (f: Awaited<ReturnType<typeof setup>>) => f.db.transaction(async tx => (await tx.query('SELECT decided_by,outcome FROM bot_recommendation_decisions')).rows);

test('without a policy nothing is automatic, and only the owner sets one', async () => {
  const f = await setup(); try {
    await f.fitness.report(evaluator, key(), { botId: 'bot-one', role: 'trader', baseline: 'cash', testName: 'live-paper all releases', periodFrom: '2026-01-01',
      periodTo: today, judged: 30, wins: 4, losses: 26 });
    await f.management.review(evaluator, key());
    assert.deepEqual(await f.autonomy.apply(evaluator, key()), { status: 'no-policy', actions: [] });
    assert.equal(await f.db.transaction(tx => isSuspended(tx, 'bot-one')), false);
    assert.throws(() => f.autonomy.setPolicy(evaluator, key(), { rules: OFF, reason: 'x' }));
    assert.throws(() => f.autonomy.apply(owner, key()));
    assert.throws(() => f.autonomy.setPolicy(owner, key(), { rules: { ...OFF, startingBudgetPaise: '1000' }, reason: 'x' }), says(/needs raiseBudget/));
  } finally { await f.db.close(); }
});

test('a standing approval suspends a bot the review flags, as the policy, and leaves the rest for the owner', async () => {
  const f = await setup(); try {
    await f.autonomy.setPolicy(owner, key(), { rules: { ...OFF, suspendOnRecommendation: true }, reason: 'Stop losing bots without waiting for me' });
    await f.fitness.report(evaluator, key(), { botId: 'bot-one', role: 'trader', baseline: 'cash', testName: 'live-paper all releases', periodFrom: '2026-01-01',
      periodTo: today, judged: 30, wins: 4, losses: 26 });
    await f.management.review(evaluator, key());
    const run = await f.autonomy.apply(evaluator, key());
    assert.deepEqual(run.actions, [{ kind: 'suspend', target: 'bot-one' }]);
    assert.equal(await f.db.transaction(tx => isSuspended(tx, 'bot-one')), true);
    assert.deepEqual(await decidedBy(f), [{ decided_by: 'autonomy-policy', outcome: 'accepted' }]); // visibly the policy's decision
    assert.equal((await f.autonomy.apply(evaluator, key())).actions.length, 0); // nothing left to do
    // a watch is not acknowledged: the policy does not cover it
    const watch = await recommend(f, 'watch', null);
    assert.equal((await f.autonomy.apply(evaluator, key())).actions.length, 0);
    assert.equal((await f.management.agenda(owner)).items.some(i => i.id === watch), true);
    assert.equal((await f.autonomy.view(owner)).recent[0]!.kind, 'suspend');
    await assert.rejects(() => f.db.transaction(tx => tx.query('DELETE FROM autonomy_actions')));
    assert.equal((await f.ops.verifyAudit(owner)).valid, true);
  } finally { await f.db.close(); }
});

test('budget raises stay within the per-change limit and the monthly total', async () => {
  const f = await setup(); try {
    await f.autonomy.setPolicy(owner, key(), { rules: { ...OFF, raiseBudget: { maxPctPerChange: 25, maxTotalPaisePerMonth: '150000' } }, reason: 'Reward proven bots' });
    await recommend(f, 'raise-budget', '700000'); // +40%: too large for the policy
    const big = await f.autonomy.apply(evaluator, key());
    assert.deepEqual([big.actions, big.leftForOwner![0]!.reason], [[], 'larger than the policy allows per change']);
    await recommend(f, 'raise-budget', '600000'); // +20%: covered
    assert.deepEqual((await f.autonomy.apply(evaluator, key())).actions, [{ kind: 'raise-budget', target: 'bot-one', amountPaise: '100000' }]);
    await recommend(f, 'raise-budget', '700000'); // +16.7%, but only 50000 of the month's 150000 remain
    assert.equal((await f.autonomy.apply(evaluator, key())).leftForOwner![0]!.reason, 'over the policy\'s monthly total');
    assert.equal((await f.autonomy.view(owner)).automaticBudgetThisMonthPaise, '100000');
  } finally { await f.db.close(); }
});

test('a new bot can go from birth to funded paper trading under standing approvals, with every rule still checked', async () => {
  const f = await setup(); try {
    const e = await f.evidence();
    await f.db.transaction(tx => tx.query("INSERT INTO departments(id,name,mandate,budget_paise,status) VALUES('rnd','R&D','New strategies',300000,'active')"));
    await f.autonomy.setPolicy(owner, key(), { rules: { ...OFF, approveBirths: true, activateReleases: true, qualifyBots: true,
      raiseBudget: { maxPctPerChange: 25, maxTotalPaisePerMonth: '1000000' }, startingBudgetPaise: '500000' }, reason: 'Let R&D grow the firm' });
    await new BotBirths(f.db).propose(researcher, key(), { botId: 'rnd-idea', name: 'Idea', department: 'rnd', specialty: 'idea', method: 'rules',
      contribution: 'A tested idea', opportunity: 'Beat the basket', successCriterion: 'Beats cash live', evidenceIds: [e.evidenceId] });
    assert.deepEqual((await f.autonomy.apply(evaluator, key())).actions.map(a => a.kind), ['birth']); // born in school, zero budget
    const report = await f.fitness.report(evaluator, key(), { botId: 'rnd-idea', role: 'allocator', baseline: 'equal-weight-basket', testName: 'scout',
      periodFrom: '2026-01-01', periodTo: today, judged: 30, wins: 25, losses: 5, model: 'rules:idea' });
    const release = await f.releases.create(researcher, key(), { botId: 'rnd-idea', model: 'rules:idea', promptVersion: 'v1', codeFingerprint: 'b'.repeat(16), notes: 'Idea' });
    await f.releases.evaluate(evaluator, key(), { releaseId: release.id, fitnessReportId: report.id });
    const run = await f.autonomy.apply(evaluator, key());
    // activated, qualified, then funded: capped by the department's 300000 ceiling, not the policy's 500000
    assert.deepEqual(run.actions, [{ kind: 'release', target: 'rnd-idea' }, { kind: 'qualification', target: 'rnd-idea' },
      { kind: 'starting-budget', target: 'rnd-idea', amountPaise: '300000' }]);
    const bot = (await f.db.transaction(tx => tx.query("SELECT state,budget_paise::text AS b FROM bots WHERE id='rnd-idea'"))).rows[0]!;
    assert.deepEqual([bot.state, bot.b], ['paper', '300000']);
    // a halt stops everything automatic
    await f.db.transaction(tx => tx.query('UPDATE system_lock SET halted=true WHERE id=1'));
    assert.equal((await f.autonomy.apply(evaluator, key())).status, 'halted');
  } finally { await f.db.close(); }
});

test('autonomy routes are guarded by role', async () => {
  const { cfg } = config(), db = await Database.open(), app = await createApp(cfg, db, true);
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const call = (method: string, path: string, role: string, body = '{}') => fetch(base + '/v1/' + path, { method, ...(method === 'POST' ? { body } : {}),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key(), Authorization: 'Bearer ' + cfg.principals.find(p => p.role === role)!.token } });
    assert.equal((await call('POST', 'autonomy/policy', 'evaluator', JSON.stringify({ rules: OFF, reason: 'x' }))).status, 403);
    assert.equal((await call('POST', 'autonomy/apply', 'owner')).status, 403);
    assert.equal((await call('POST', 'autonomy/apply', 'evaluator')).status, 201);
    assert.equal((await call('GET', 'autonomy', 'owner')).status, 200);
  } finally { await app.close(); await db.close(); }
});
