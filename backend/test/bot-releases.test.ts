import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, config, owner, researcher, evaluator, key } from './helpers.js';
import { BotReleases } from '../src/bot-releases.js';
import { BotFitness } from '../src/bot-fitness.js';
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
    assert.equal((await releases.check(researcher, { botId: 'allocator', ...v(SMALL, 'changed-prompt') })).reason, 'version-not-authorised');

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
