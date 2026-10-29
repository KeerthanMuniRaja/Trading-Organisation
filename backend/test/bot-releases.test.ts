import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, config, owner, researcher, evaluator, key } from './helpers.js';
import { BotReleases } from '../src/bot-releases.js';
import { BotFitness } from '../src/bot-fitness.js';
import { TradeSignals } from '../src/trade-signals.js';
import { OwnerAlerts } from '../src/alerts.js';
import { Departments } from '../src/departments.js';
import { Database } from '../src/database.js';
import { createApp } from '../src/app.js';

const says = (pattern: RegExp) => (error: any) => pattern.test(JSON.stringify(error?.getResponse?.() ?? error?.message));
const SMALL = 'Qwen3.5-4B-Q4_K_M', BIG = 'claude-opus-5-5';
const v = (model: string, promptVersion: string) => ({ model, promptVersion, codeFingerprint: 'a1b2c3d4e5f60718' });

test('a model switch: evaluate, canary beside the active release, activate, then roll back in one step', async () => {
  const f = await fixture(); try {
    await f.org.bot(owner, key(), { id: 'allocator', name: 'Allocator', department: 'portfolio', specialty: 'monthly', method: 'llm', contribution: 'Release fixture', budgetPaise: '0' });
    const releases = new BotReleases(f.db), fitness = new BotFitness(f.db);
    const report = async (model: string, wins: number, losses: number) => (await fitness.report(evaluator, key(), { botId: 'allocator', role: 'portfolio-allocator',
      baseline: 'equal-weight-basket', testName: `${model}-${wins}-${losses}`, periodFrom: '2024-10-01', periodTo: '2026-09-30', judged: 25, wins, losses, model })).id;

    const v1 = await releases.create(researcher, key(), { botId: 'allocator', ...v(SMALL, '0634b9cf839d47d2'), notes: 'Taught 4B allocator (lessons-v1)' });
    assert.equal(v1.version, 1);
    assert.equal((await releases.create(researcher, key(), { botId: 'allocator', ...v(SMALL, '0634b9cf839d47d2'), notes: 'again' })).duplicate, true);
    assert.deepEqual((await releases.check(researcher, { botId: 'allocator', ...v(SMALL, '0634b9cf839d47d2') })).reason, 'no-authorised-release');

    const own = await report(SMALL, 12, 10), otherModel = await report(BIG, 12, 10);
    await assert.rejects(() => releases.evaluate({ id: 'researcher', role: 'evaluator' }, key(), { releaseId: v1.id, fitnessReportId: own }), says(/other than its author/));
    await assert.rejects(() => releases.evaluate(evaluator, key(), { releaseId: v1.id, fitnessReportId: otherModel }), says(/release's model/));
    const e1 = await releases.evaluate(evaluator, key(), { releaseId: v1.id, fitnessReportId: await report(SMALL, 12, 10) }); // 22 decisive: no-detectable-skill
    assert.deepEqual([e1.canaryEligible, e1.activeEligible], [true, true]);
    await releases.stage(owner, key(), { releaseId: v1.id, stage: 'active', reason: 'Not worse than the basket on 25 months' });
    assert.equal((await releases.check(researcher, { botId: 'allocator', ...v(SMALL, '0634b9cf839d47d2') })).stage, 'active');
    const refused = await releases.check(researcher, { botId: 'allocator', ...v(SMALL, 'changed-prompt') });
    assert.equal(refused.reason, 'version-not-authorised');
    assert.equal(refused.authorised?.releaseId, v1.id);  // a renewal judges new code on this release's live record

    // the stronger model arrives with little evidence: canary only, running beside the active 4B release
    const v2 = await releases.create(owner, key(), { botId: 'allocator', ...v(BIG, '0634b9cf839d47d2'), settings: { timeoutSeconds: 120 }, notes: 'Same lessons, stronger model' });
    await releases.evaluate(evaluator, key(), { releaseId: v2.id, fitnessReportId: await report(BIG, 5, 3) }); // 8 decisive: insufficient evidence
    await assert.rejects(() => releases.stage(owner, key(), { releaseId: v2.id, stage: 'active', reason: 'too early' }), says(/enough evidence/));
    assert.throws(() => releases.stage(evaluator, key(), { releaseId: v2.id, stage: 'canary', reason: 'not the owner' }));
    await releases.stage(owner, key(), { releaseId: v2.id, stage: 'canary', reason: 'Trial beside the 4B release' });
    const trial = await releases.check(researcher, { botId: 'allocator', ...v(BIG, '0634b9cf839d47d2') });
    assert.deepEqual([trial.allowed, trial.stage, trial.settings], [true, 'canary', { timeoutSeconds: 120 }]);
    assert.equal((await releases.check(researcher, { botId: 'allocator', ...v(SMALL, '0634b9cf839d47d2') })).stage, 'active');

    // it proves itself, becomes the active release, and the old one stops being authorised
    await releases.evaluate(evaluator, key(), { releaseId: v2.id, fitnessReportId: await report(BIG, 18, 4) }); // adds value
    await releases.stage(owner, key(), { releaseId: v2.id, stage: 'active', reason: 'Beat the basket with enough evidence' });
    assert.equal((await releases.check(researcher, { botId: 'allocator', ...v(BIG, '0634b9cf839d47d2') })).stage, 'active');
    assert.equal((await releases.check(researcher, { botId: 'allocator', ...v(SMALL, '0634b9cf839d47d2') })).allowed, false);

    // one-step rollback: v2 revoked, v1 active again; a revoked release cannot be staged again
    const back = await releases.rollback(owner, key(), { botId: 'allocator', reason: 'Unexpected cost' });
    assert.deepEqual([back.revoked, back.active], [v2.id, v1.id]);
    assert.equal((await releases.check(researcher, { botId: 'allocator', ...v(SMALL, '0634b9cf839d47d2') })).stage, 'active');
    assert.equal((await releases.check(researcher, { botId: 'allocator', ...v(BIG, '0634b9cf839d47d2') })).allowed, false);
    await assert.rejects(() => releases.stage(owner, key(), { releaseId: v2.id, stage: 'canary', reason: 'retry' }), says(/register a new one/));

    const view = await releases.view(owner, { botId: 'allocator' });
    assert.deepEqual(view.releases.map(r => [r.version, r.stage]), [[1, 'active'], [2, 'revoked']]);
    assert.equal(view.releases[1]!.evaluations.length, 2);
    await assert.rejects(() => f.db.transaction(tx => tx.query("UPDATE bot_release_stages SET stage='active'")));
    assert.equal((await f.ops.verifyAudit(owner)).valid, true);
  } finally { await f.db.close(); }
});

test('trade proposals are gated by release: only the active release or a canary may propose, and each is stamped', async () => {
  const f = await fixture(); try {
    const e = await f.evidence();
    await f.org.bot(owner, key(), { id: 'allocator', name: 'Allocator', department: 'portfolio', specialty: 'monthly', method: 'llm', contribution: 'Gate fixture', budgetPaise: '0' });
    const worker = { id: 'alloc-worker', role: 'trader' as const, botId: 'allocator' };
    const releases = new BotReleases(f.db), fitness = new BotFitness(f.db), signals = new TradeSignals(f.db, f.cfg);
    const proposal = (model: string, promptVersion: string, thesis = 'Monthly tilt') => signals.propose(worker, key(), { botId: 'allocator', symbol: 'RELIANCE',
      action: 'enter-long', horizonDays: 30, conviction: 'medium', thesis, invalidation: 'Breaks support', expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      evidenceIds: [e.evidenceId], model, promptVersion });
    assert.equal((await proposal(SMALL, 'p1', 'Before any release')).duplicate, false); // no releases yet: unchanged behaviour

    const report = async (model: string, wins: number, losses: number) => (await fitness.report(evaluator, key(), { botId: 'allocator', role: 'portfolio-allocator',
      baseline: 'equal-weight-basket', testName: `${model}-${wins}`, periodFrom: '2024-10-01', periodTo: '2026-09-30', judged: 25, wins, losses, model })).id;
    const v1 = await releases.create(researcher, key(), { botId: 'allocator', ...v(SMALL, 'p1'), notes: 'v1' });
    await releases.evaluate(evaluator, key(), { releaseId: v1.id, fitnessReportId: await report(SMALL, 12, 10) });
    await releases.stage(owner, key(), { releaseId: v1.id, stage: 'active', reason: 'go' });

    const ok = await proposal(SMALL, 'p1', 'From the active release');
    await assert.rejects(() => proposal(BIG, 'p1', 'Unauthorised model'), says(/not an authorised release/));
    await assert.rejects(() => proposal(SMALL, 'p2', 'Unauthorised prompt'), says(/not an authorised release/));
    const v2 = await releases.create(owner, key(), { botId: 'allocator', ...v(BIG, 'p1'), notes: 'v2' });
    await releases.evaluate(evaluator, key(), { releaseId: v2.id, fitnessReportId: await report(BIG, 5, 3) });
    await releases.stage(owner, key(), { releaseId: v2.id, stage: 'canary', reason: 'trial' });
    const trial = await proposal(BIG, 'p1', 'From the canary');
    const view = await signals.query(owner, {});
    assert.equal(view.signals.find(s => s.id === ok.id)!.releaseId, v1.id);
    assert.equal(view.signals.find(s => s.id === trial.id)!.releaseId, v2.id);
    await releases.stage(owner, key(), { releaseId: v2.id, stage: 'revoked', reason: 'stop the trial' });
    await assert.rejects(() => proposal(BIG, 'p1', 'After revocation'), says(/not an authorised release/));
  } finally { await f.db.close(); }
});

test('evaluations expire: a stale one cannot stage a release, and an active release on a stale evaluation is alerted', async () => {
  const f = await fixture(); try {
    await f.org.bot(owner, key(), { id: 'allocator', name: 'Allocator', department: 'portfolio', specialty: 'monthly', method: 'llm', contribution: 'Expiry fixture', budgetPaise: '0' });
    const releases = new BotReleases(f.db);
    const rel = await releases.create(researcher, key(), { botId: 'allocator', ...v(SMALL, 'p1'), notes: 'v1' });
    const report = (await new BotFitness(f.db).report(evaluator, key(), { botId: 'allocator', role: 'portfolio-allocator', baseline: 'equal-weight-basket',
      testName: 'old', periodFrom: '2025-01-01', periodTo: '2025-03-31', judged: 25, wins: 12, losses: 10, model: SMALL })).id;
    // an evaluation recorded 200 days ago (history cannot be back-dated through the API)
    await f.db.transaction(tx => tx.query(`INSERT INTO bot_release_evaluations(id,release_id,fitness_report_id,fitness_verdict,canary_eligible,active_eligible,evaluator,created_at)
      VALUES($1,$2,$3,'no-detectable-skill',true,true,'evaluator',now()-interval '200 days')`, [crypto.randomUUID(), rel.id, report]));
    await assert.rejects(() => releases.stage(owner, key(), { releaseId: rel.id, stage: 'active', reason: 'old evidence' }), says(/older than 180 days/));
    // it had been activated back then: the alert asks for a re-test
    await f.db.transaction(tx => tx.query(`INSERT INTO bot_release_stages(id,bot_id,release_id,stage,reason,decided_by,created_at)
      VALUES($1,'allocator',$2,'active','activated long ago','owner',now()-interval '199 days')`, [crypto.randomUUID(), rel.id]));
    const raised = (await new OwnerAlerts(f.db, f.cfg).cycle(evaluator, key())).raised;
    assert.deepEqual(raised.map(a => [a.rule, a.subject]), [['release-evaluation-expired', 'allocator/v1']]);
    // a fresh evaluation clears it
    const fresh = (await new BotFitness(f.db).report(evaluator, key(), { botId: 'allocator', role: 'portfolio-allocator', baseline: 'equal-weight-basket',
      testName: 'recent', periodFrom: '2026-07-01', periodTo: '2026-09-30', judged: 25, wins: 13, losses: 9, model: SMALL })).id;
    await releases.evaluate(evaluator, key(), { releaseId: rel.id, fitnessReportId: fresh });
    assert.equal((await new OwnerAlerts(f.db, f.cfg).cycle(evaluator, key())).resolved, 1);
  } finally { await f.db.close(); }
});

test('the owner qualifies a bot for paper trading only on an active, freshly evaluated release', async () => {
  const f = await fixture(); try {
    await f.org.bot(owner, key(), { id: 'momentum-rules', name: 'Momentum rules', department: 'portfolio', specialty: 'top3-momentum', method: 'rules',
      contribution: 'Monthly top-3 momentum', budgetPaise: '400000' });
    const releases = new BotReleases(f.db);
    await assert.rejects(() => releases.qualify(owner, key(), { botId: 'momentum-rules', reason: 'too early' }), says(/active release/));
    const rel = await releases.create(researcher, key(), { botId: 'momentum-rules', ...v('rules:top3-momentum-6m', 'r1'), notes: 'Rule bot' });
    const report = (await new BotFitness(f.db).report(evaluator, key(), { botId: 'momentum-rules', role: 'portfolio-allocator', baseline: 'equal-weight-basket',
      testName: 'regime-study-2022-2026 (seen data)', periodFrom: '2022-08-01', periodTo: '2026-09-30', judged: 50, wins: 32, losses: 18, model: 'rules:top3-momentum-6m' })).id;
    const evaluation = await releases.evaluate(evaluator, key(), { releaseId: rel.id, fitnessReportId: report });
    assert.equal(evaluation.activeEligible, true); // 32 ahead / 18 behind over 50 months: adds value (p ~ 0.03)
    await releases.stage(owner, key(), { releaseId: rel.id, stage: 'active', reason: 'Qualified on the regime study' });
    assert.throws(() => releases.qualify(evaluator, key(), { botId: 'momentum-rules', reason: 'not the owner' }));
    const q = await releases.qualify(owner, key(), { botId: 'momentum-rules', reason: 'Paper trading under forward observation' });
    assert.deepEqual([q.state, q.releaseId], ['paper', rel.id]);
    await assert.rejects(() => releases.qualify(owner, key(), { botId: 'momentum-rules', reason: 'again' }), says(/already qualified/));
    assert.equal((await f.ops.verifyAudit(owner)).valid, true);
  } finally { await f.db.close(); }
});

test('department budget ceilings beyond available capital are alerted', async () => {
  const f = await fixture(); try {
    const e = await f.evidence();
    await f.deposit('500000');
    const depts = new Departments(f.db);
    const p = await depts.propose(researcher, key(), { kind: 'open', departmentId: 'desk', name: 'Desk', mandate: 'Paper trading', rationale: 'Need', evidenceIds: [e.evidenceId] });
    await depts.decide(owner, key(), { proposalId: p.id, outcome: 'approved', budgetPaise: '2000000', note: 'Ambitious ceiling' });
    const raised = (await new OwnerAlerts(f.db, f.cfg).cycle(evaluator, key())).raised;
    assert.deepEqual(raised.map(a => a.rule), ['budgets-exceed-capital']);
  } finally { await f.db.close(); }
});

test('a later worse evaluation withdraws eligibility; release routes are guarded', async () => {
  const f = await fixture(); try {
    await f.org.bot(owner, key(), { id: 'allocator', name: 'Allocator', department: 'portfolio', specialty: 'monthly', method: 'llm', contribution: 'Release fixture', budgetPaise: '0' });
    const releases = new BotReleases(f.db), fitness = new BotFitness(f.db);
    const rel = await releases.create(researcher, key(), { botId: 'allocator', ...v(SMALL, 'p1'), notes: 'v1' });
    const report = async (wins: number, losses: number) => (await fitness.report(evaluator, key(), { botId: 'allocator', role: 'portfolio-allocator',
      baseline: 'equal-weight-basket', testName: `t-${wins}-${losses}`, periodFrom: '2024-10-01', periodTo: '2026-09-30', judged: 30, wins, losses, model: SMALL })).id;
    await releases.evaluate(evaluator, key(), { releaseId: rel.id, fitnessReportId: await report(12, 10) });
    await releases.evaluate(evaluator, key(), { releaseId: rel.id, fitnessReportId: await report(3, 20) }); // now worse than the basket
    await assert.rejects(() => releases.stage(owner, key(), { releaseId: rel.id, stage: 'canary', reason: 'try' }), says(/not worse/));
  } finally { await f.db.close(); }
  const { cfg } = config(), db = await Database.open(), app = await createApp(cfg, db, true);
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const post = (path: string, role: string, body: unknown = {}) => fetch(base + '/v1' + path, { method: 'POST', body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key(), Authorization: 'Bearer ' + cfg.principals.find(p => p.role === role)!.token } });
    assert.equal((await post('/releases/stages', 'evaluator')).status, 403);
    assert.equal((await post('/releases', 'trader')).status, 403);
    assert.equal((await post('/releases/check', 'trader', { botId: 'someone-else', ...v(SMALL, 'p1') })).status, 403); // bound to its own bot
  } finally { await app.close(); await db.close(); }
});
