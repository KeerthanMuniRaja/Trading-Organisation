import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, config, owner, researcher, evaluator, key } from './helpers.js';
import { Management, assess, LIMITS } from '../src/management.js';
import { BotFitness } from '../src/bot-fitness.js';
import { BotReleases } from '../src/bot-releases.js';
import { BotBirths } from '../src/bot-births.js';
import { Departments } from '../src/departments.js';
import { isSuspended } from '../src/bot-control.js';
import { Database } from '../src/database.js';
import { createApp } from '../src/app.js';

const says = (pattern: RegExp) => (error: any) => pattern.test(JSON.stringify(error?.getResponse?.() ?? error?.message));
const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const healthy = { suspended: false, suspendedDays: null, liveVerdict: 'no-detectable-skill', livePValue: 0.4, liveJudged: 25, returnOnBudgetPct: 2,
  maxDrawdownPct: 5, snapshotDays: 30, excessOverBasketPct: 1, lapsed30: 0, executed30: 3, openPositions: 2, budgetPaise: '500000', daysSinceBudgetChange: null };

async function setup() {
  const f = await fixture();
  await f.org.bot(owner, key(), { id: 'bot-one', name: 'Worker', department: 'desk', specialty: 'demo', method: 'test', contribution: 'Management fixture', budgetPaise: '500000' });
  await f.db.transaction(tx => tx.query("UPDATE bots SET state='paper' WHERE id='bot-one'"));
  return { ...f, management: new Management(f.db, f.cfg), fitness: new BotFitness(f.db), releases: new BotReleases(f.db) };
}
const live = (wins: number, losses: number) => ({ botId: 'bot-one', role: 'trader', baseline: 'cash' as const, testName: 'live-paper all releases',
  periodFrom: '2026-01-01', periodTo: today, judged: wins + losses, wins, losses });

test('management-v1: each rule, in order, and silence when nothing needs the owner', () => {
  assert.equal(assess(healthy, null), null);
  assert.equal(assess({ ...healthy, liveVerdict: 'worse-than-baseline' }, null)?.kind, 'suspend');
  // management-v3 (still in v5): at the loss limit, a bot behind the basket (or not yet compared) is suspended; one ahead of it is watched
  assert.equal(assess({ ...healthy, returnOnBudgetPct: LIMITS.suspendLossPct, excessOverBasketPct: -1 }, null)?.rule, 'loss-limit');
  assert.equal(assess({ ...healthy, returnOnBudgetPct: LIMITS.suspendLossPct, excessOverBasketPct: null }, null)?.kind, 'suspend');
  const crash = assess({ ...healthy, returnOnBudgetPct: -17, excessOverBasketPct: 6 }, null);
  assert.deepEqual([crash?.kind, crash?.rule], ['watch', 'market-fall']);
  assert.equal(assess({ ...healthy, returnOnBudgetPct: -9 }, null)?.rule, 'losing');
  assert.equal(assess({ ...healthy, maxDrawdownPct: 21 }, null)?.rule, 'deep-drawdown');
  assert.equal(assess({ ...healthy, lapsed30: 3, executed30: 0 }, null)?.rule, 'not-executing');
  const proven = { ...healthy, liveVerdict: 'adds-value', livePValue: 0.01, snapshotDays: 60, excessOverBasketPct: 3, returnOnBudgetPct: 6 };
  assert.deepEqual([assess(proven, 625000n)?.kind, assess(proven, 625000n)?.proposedBudgetPaise], ['raise-budget', '625000']);
  assert.equal(assess(proven, null), null); // no room under the department ceiling or exposure limit: no raise
  assert.equal(assess({ ...proven, snapshotDays: 59 }, 625000n), null); // too early to judge
  assert.equal(assess({ ...proven, daysSinceBudgetChange: 30 }, 625000n), null); // budget changed recently
  // a suspended bot is only reconsidered for retirement, once it has had time and holds nothing
  const parked = { ...healthy, suspended: true, suspendedDays: 31, liveVerdict: 'worse-than-baseline', openPositions: 0 };
  assert.equal(assess(parked, null)?.kind, 'retire');
  assert.equal(assess({ ...parked, openPositions: 1 }, null), null);
  assert.equal(assess({ ...parked, suspendedDays: 10 }, null), null);
});

test('management-v2: a bot that keeps trailing the basket without proven skill gets less money, never below the floor', async () => {
  const trailing = { ...healthy, snapshotDays: 60, excessOverBasketPct: -3 };
  assert.deepEqual([assess(trailing, null)?.kind, assess(trailing, null)?.proposedBudgetPaise], ['reduce-budget', '375000']); // 25% less
  assert.equal(assess({ ...trailing, excessOverBasketPct: -2.9 }, null), null);          // close to the basket: no cut
  assert.equal(assess({ ...trailing, snapshotDays: 59 }, null), null);                   // too early to judge
  assert.equal(assess({ ...trailing, daysSinceBudgetChange: 30 }, null), null);          // budget changed recently
  assert.equal(assess({ ...trailing, liveVerdict: 'adds-value' }, null), null);          // proven skill is not cut for one weak stretch
  assert.equal(assess({ ...trailing, budgetPaise: '120000' }, null)?.proposedBudgetPaise, String(LIMITS.minBudgetPaise)); // the floor
  assert.equal(assess({ ...trailing, budgetPaise: String(LIMITS.minBudgetPaise) }, null), null);  // already at the floor
  // the owner, or a standing approval, applies it; it only ever lowers the budget
  const f = await setup(); try {
    const reviewed = await f.db.transaction(async tx => {
      const id = randomUUID();
      await tx.query(`INSERT INTO bot_recommendations(id,bot_id,kind,rule,reason,proposed_budget_paise,facts,proposer,content_hash)
        VALUES($1,'bot-one','reduce-budget','trails-basket','fixture',375000,'{}'::jsonb,'evaluator',$2)`, [id, 'h-' + id]);
      return id;
    });
    const decided = await f.management.decide(owner, key(), { recommendationId: reviewed, outcome: 'accepted', note: 'Budget follows evidence' });
    assert.equal(decided.kind, 'reduce-budget');
    assert.equal((await f.db.transaction(tx => tx.query("SELECT budget_paise::text AS b FROM bots WHERE id='bot-one'"), false)).rows[0]!.b, '375000');
  } finally { await f.db.close(); }
});

test('management-v4: a loss-limit suspension has a way back, with less money; other suspensions stay with the owner', () => {
  const served = { ...healthy, suspended: true, suspendedDays: LIMITS.reinstateAfterDays, suspendedRule: 'loss-limit', returnOnBudgetPct: -16, openPositions: 0 };
  const back = assess(served, null);
  assert.deepEqual([back?.kind, back?.rule, back?.proposedBudgetPaise], ['reinstate', 'suspension-served', '375000']); // 25% less
  assert.equal(assess({ ...served, suspendedDays: LIMITS.reinstateAfterDays - 1 }, null), null);        // not served yet
  assert.equal(assess({ ...served, suspendedRule: 'live-worse-than-cash' }, null), null);               // failing calls: the owner's call
  assert.equal(assess({ ...served, suspendedRule: null }, null), null);                                 // the owner's own suspension
  assert.equal(assess({ ...served, liveVerdict: 'worse-than-baseline' }, null), null);                  // its calls now lose to cash
  assert.equal(assess({ ...served, openPositions: 2 }, null), null);                                    // still holding, still at the loss
  assert.equal(assess({ ...served, openPositions: 2, returnOnBudgetPct: -10 }, null)?.kind, 'reinstate'); // holding, but recovered
  assert.equal(assess({ ...served, budgetPaise: String(LIMITS.minBudgetPaise) }, null)?.proposedBudgetPaise, String(LIMITS.minBudgetPaise)); // the floor
  // back at work, only the loss since the reinstatement counts: the old loss cannot suspend it again
  const returned = { ...healthy, returnOnBudgetPct: -16, excessOverBasketPct: -4, valueChangePct: -2, sinceResume: true };
  assert.equal(assess(returned, null), null);
  const again = assess({ ...returned, valueChangePct: -15 }, null);
  assert.equal(again?.rule, 'loss-limit');
  assert.match(again!.reason, /since it was reinstated/);
  assert.equal(assess({ ...returned, valueChangePct: -9 }, null)?.rule, 'losing');
});

test('management-v5: losses are measured on value with budget changes taken out, so a cut cannot invite a suspension', async () => {
  // Rs 600 lost on Rs 5,000 is -12%; after a cut to Rs 3,750 it is -16% "of budget", but its value fell 12%: watched, not suspended
  const cut = { ...healthy, returnOnBudgetPct: -16, valueChangePct: -12, excessOverBasketPct: -2 };
  assert.deepEqual([assess(cut, null)?.kind, assess(cut, null)?.rule], ['watch', 'losing']);
  assert.equal(assess({ ...cut, valueChangePct: null }, null)?.rule, 'loss-limit'); // no snapshots yet: falls back to budget
  // through the real review: a 25% cut with nothing else changed raises no deep-drawdown watch and no loss concern
  const f = await setup(); try {
    await f.db.transaction(async tx => {
      for (const [ago, budget] of [[3, 500000], [2, 500000], [1, 375000], [0, 375000]] as const)
        await tx.query(`INSERT INTO paper_performance_snapshots(id,day,bot_id,budget_paise,realised_paise,unrealised_paise,open_positions,unpriced_or_stale,recorder)
          VALUES($1,((now() AT TIME ZONE 'UTC') + interval '330 minutes')::date-$2::int,'bot-one',$3,-40000,0,0,0,'evaluator')`, [randomUUID(), ago, budget]);
      await tx.query("UPDATE bots SET budget_paise=375000 WHERE id='bot-one'");
    });
    const reviewed = await f.management.review(evaluator, key());
    assert.deepEqual(reviewed.filed.map(r => r.rule), []); // under v4: deep-drawdown (25% "fall")
  } finally { await f.db.close(); }
});

test('management-v4: the review recommends reinstatement, accepting lifts the suspension with the smaller budget, and the old loss is not counted again', async () => {
  const f = await setup(); try {
    // suspended by the loss limit 25 days ago: the accepted recommendation and the suspension share one transaction time
    await f.db.transaction(async tx => {
      const id = randomUUID();
      await tx.query(`INSERT INTO bot_recommendations(id,bot_id,kind,rule,reason,facts,proposer,content_hash,created_at)
        VALUES($1,'bot-one','suspend','loss-limit','Lost 16% of its budget','{}'::jsonb,'evaluator',$2,now()-interval '25 days')`, [id, 'h-' + id]);
      await tx.query(`INSERT INTO bot_recommendation_decisions(recommendation_id,outcome,note,decided_by,created_at)
        VALUES($1,'accepted','Stop new risk','autonomy-policy',now()-interval '25 days')`, [id]);
      await tx.query(`INSERT INTO bot_suspensions(id,bot_id,suspended,reason,decided_by,created_at)
        VALUES($1,'bot-one',true,'Management recommendation accepted','autonomy-policy',now()-interval '25 days')`, [randomUUID()]);
    });
    const reviewed = await f.management.review(evaluator, key());
    assert.deepEqual(reviewed.filed.map(r => [r.kind, r.rule]), [['reinstate', 'suspension-served']]);
    assert.equal(await f.db.transaction(tx => isSuspended(tx, 'bot-one')), true); // a recommendation changes nothing by itself
    const agenda = await f.management.agenda(owner);
    assert.match(String(agenda.items[0]!.action), /lift the suspension, with a budget of 375000 paise/);

    const decided = await f.management.decide(owner, key(), { recommendationId: String(reviewed.filed[0]!.id), outcome: 'accepted', note: 'Back to work' });
    assert.deepEqual(decided.applied, { botId: 'bot-one', suspended: false, budget: { botId: 'bot-one', budgetBeforePaise: '500000', budgetPaise: '375000' } });
    assert.equal(await f.db.transaction(tx => isSuspended(tx, 'bot-one')), false);
    assert.equal((await f.management.review(evaluator, key())).filed.length, 0); // nothing lost since: not suspended again
    assert.equal((await f.ops.verifyAudit(owner)).valid, true);
  } finally { await f.db.close(); }
});

test('the daily review recommends, the owner decides, and accepting applies the change atomically', async () => {
  const f = await setup(); try {
    await f.fitness.report(evaluator, key(), live(4, 26));
    const first = await f.management.review(evaluator, key());
    assert.deepEqual(first.filed.map(r => [r.botId, r.kind, r.rule]), [['bot-one', 'suspend', 'live-worse-than-cash']]);
    assert.equal((await f.management.review(evaluator, key())).filed.length, 0); // waiting for the owner: not repeated
    assert.equal(await f.db.transaction(tx => isSuspended(tx, 'bot-one')), false); // a recommendation changes nothing by itself
    assert.throws(() => f.management.review(owner, key()));
    assert.throws(() => f.management.decide(evaluator, key(), { recommendationId: first.filed[0]!.id, outcome: 'accepted', note: 'x' }));

    const id = String(first.filed[0]!.id);
    const decided = await f.management.decide(owner, key(), { recommendationId: id, outcome: 'accepted', note: 'Agreed: stop new risk' });
    assert.equal(decided.outcome, 'accepted');
    assert.equal(await f.db.transaction(tx => isSuspended(tx, 'bot-one')), true);
    await assert.rejects(() => f.management.decide(owner, key(), { recommendationId: id, outcome: 'declined', note: 'again' }), says(/already decided/));
    assert.equal((await f.management.review(evaluator, key())).filed.length, 0); // suspended and recently decided: quiet
    await assert.rejects(() => f.db.transaction(tx => tx.query('DELETE FROM bot_recommendations')));
    await assert.rejects(() => f.db.transaction(tx => tx.query("UPDATE bot_recommendation_decisions SET outcome='declined'")));
    assert.equal((await f.ops.verifyAudit(owner)).valid, true);
  } finally { await f.db.close(); }
});

test('a raise respects the department ceiling when the owner accepts, and only the newest recommendation can be decided', async () => {
  const f = await setup(); try {
    await f.db.transaction(tx => tx.query("INSERT INTO departments(id,name,mandate,budget_paise,status) VALUES('desk','Desk','Trade the shares',600000,'active')"));
    const recommend = (kind: string, budget: string | null) => f.db.transaction(async tx => {
      const id = randomUUID();
      await tx.query(`INSERT INTO bot_recommendations(id,bot_id,kind,rule,reason,proposed_budget_paise,facts,proposer,content_hash)
        VALUES($1,'bot-one',$2,'test','Fixture recommendation',$3,'{}'::jsonb,'evaluator',$4)`, [id, kind, budget, randomUUID()]);
      return id;
    });
    const tooMuch = await recommend('raise-budget', '625000');
    await assert.rejects(() => f.management.decide(owner, key(), { recommendationId: tooMuch, outcome: 'accepted', note: 'Earned it' }), says(/ceiling/));
    const watch = await recommend('watch', null);
    await assert.rejects(() => f.management.decide(owner, key(), { recommendationId: tooMuch, outcome: 'declined', note: 'x' }), says(/newer recommendation/));
    await f.management.decide(owner, key(), { recommendationId: watch, outcome: 'accepted', note: 'Keeping an eye on it' });
    const fits = await recommend('raise-budget', '600000');
    const raised = await f.management.decide(owner, key(), { recommendationId: fits, outcome: 'accepted', note: 'Earned it' });
    assert.deepEqual(raised.applied, { botId: 'bot-one', budgetBeforePaise: '500000', budgetPaise: '600000' });
    assert.equal((await f.db.transaction(tx => tx.query('SELECT count(*)::int AS n FROM bot_budget_changes'))).rows[0]!.n, 1);
    const retire = await recommend('retire', null);
    await assert.rejects(() => f.management.decide(owner, key(), { recommendationId: retire, outcome: 'accepted', note: 'Done' }), says(/Retire the bot first/));
  } finally { await f.db.close(); }
});

test('the owner agenda gathers every decision waiting on the owner', async () => {
  const f = await setup(); try {
    const e = await f.evidence();
    const departments = new Departments(f.db), births = new BotBirths(f.db);
    const opened = await departments.propose(researcher, key(), { kind: 'open', departmentId: 'rnd', name: 'R&D', mandate: 'New strategies',
      rationale: 'Research capacity', evidenceIds: [e.evidenceId] });
    let agenda = await f.management.agenda(owner);
    assert.deepEqual(agenda.items.map(i => i.type), ['department']);
    await departments.decide(owner, key(), { proposalId: opened.id, outcome: 'approved', budgetPaise: '1000000', note: 'Open it' });
    await births.propose(researcher, key(), { botId: 'mean-revert', name: 'Mean reversion', department: 'rnd', specialty: 'reversal', method: 'rules',
      contribution: 'Buys short-term falls', opportunity: 'Oversold large caps rebound', successCriterion: 'Beats cash over 20 calls', evidenceIds: [e.evidenceId] });
    // a candidate bot whose release passed its evaluation: first its activation, then its qualification, wait for the owner
    await f.org.bot(owner, key(), { id: 'candidate', name: 'Candidate', department: 'desk', specialty: 'cand', method: 'rules', contribution: 'Candidate fixture', budgetPaise: '0' });
    const report = await f.fitness.report(evaluator, key(), { ...live(25, 5), botId: 'candidate', role: 'allocator', baseline: 'equal-weight-basket',
      testName: 'regime study', model: 'rules' });
    const release = await f.releases.create(researcher, key(), { botId: 'candidate', model: 'rules', promptVersion: 'v1', codeFingerprint: 'a'.repeat(16), notes: 'Fixture' });
    await f.releases.evaluate(evaluator, key(), { releaseId: release.id, fitnessReportId: report.id });
    await f.fitness.report(evaluator, key(), live(4, 26));
    await f.management.review(evaluator, key());
    agenda = await f.management.agenda(owner);
    assert.deepEqual(agenda.items.map(i => i.type).sort(), ['birth', 'recommendation', 'release']);
    await f.releases.stage(owner, key(), { releaseId: release.id, stage: 'active', reason: 'Evaluated' });
    agenda = await f.management.agenda(owner);
    assert.deepEqual(agenda.items.map(i => i.type).sort(), ['birth', 'qualification', 'recommendation']);
    assert.throws(() => f.management.agenda(evaluator));
  } finally { await f.db.close(); }
});

test('management routes are guarded by role', async () => {
  const { cfg } = config(), db = await Database.open(), app = await createApp(cfg, db, true);
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const call = (method: string, path: string, role: string) => fetch(base + '/v1/' + path, { method, ...(method === 'POST' ? { body: '{}' } : {}),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key(), Authorization: 'Bearer ' + cfg.principals.find(p => p.role === role)!.token } });
    assert.equal((await call('POST', 'management/reviews', 'owner')).status, 403);
    assert.equal((await call('POST', 'management/reviews', 'evaluator')).status, 201);
    assert.equal((await call('POST', 'management/decisions', 'evaluator')).status, 403);
    assert.equal((await call('GET', 'organisation/agenda', 'evaluator')).status, 403);
    assert.equal((await call('GET', 'organisation/agenda', 'owner')).status, 200);
  } finally { await app.close(); await db.close(); }
});
