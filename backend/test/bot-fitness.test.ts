import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, config, owner, researcher, evaluator, key } from './helpers.js';
import { BotFitness, judge, recommend, signTestTail } from '../src/bot-fitness.js';
import { BotReleases } from '../src/bot-releases.js';
import { OwnerAlerts } from '../src/alerts.js';
import { Database } from '../src/database.js';
import { createApp } from '../src/app.js';

const says = (pattern: RegExp) => (error: any) => pattern.test(JSON.stringify(error?.getResponse?.() ?? error?.message));

async function setup() {
  const f = await fixture();
  await f.org.bot(owner, key(), { id: 'trend-analyst', name: 'Trend analyst', department: 'desk', specialty: 'trend', method: 'reasoning',
    contribution: 'Judges momentum continuation', budgetPaise: '0' });
  const base = { botId: 'trend-analyst', role: 'trend-analyst', baseline: 'always-neutral', testName: 'eight-weeks-v1',
    periodFrom: '2026-08-14', periodTo: '2026-10-08', judged: 86 };
  return { ...f, fitness: new BotFitness(f.db), base };
}

test('the exact sign test and verdict thresholds', () => {
  assert.ok(Math.abs(signTestTail(5, 5) - 1 / 32) < 1e-12); // computed in log space, so compare with a tolerance
  assert.ok(Math.abs(signTestTail(3, 6) - 42 / 64) < 1e-12);
  assert.ok(Math.abs(judge(16, 4).pValue - 6196 / 1048576) < 1e-12);
  assert.equal(judge(16, 4).verdict, 'adds-value');
  assert.equal(judge(4, 16).verdict, 'worse-than-baseline');
  assert.equal(judge(15, 4).verdict, 'insufficient-evidence'); // 19 disagreements
  assert.equal(judge(11, 9).verdict, 'no-detectable-skill');
  assert.equal(judge(10, 10).pValue, 1);
  const big = judge(600, 400); // no overflow on large samples
  assert.equal(big.verdict, 'adds-value');
  assert.ok(big.pValue > 0 && big.pValue < 1e-9);
  assert.equal(signTestTail(0, 40), 1);
});

test('the backend computes the verdict, requires independence and refuses impossible reports', async () => {
  const f = await setup(); try {
    const worse = await f.fitness.report(evaluator, key(), { ...f.base, wins: 5, losses: 8, failed: 0 });
    assert.equal(worse.verdict, 'insufficient-evidence'); // the real desk's trend analyst: only 13 disagreements
    assert.equal((await f.fitness.report(evaluator, key(), { ...f.base, wins: 5, losses: 8, failed: 0 })).duplicate, true);
    assert.throws(() => f.fitness.report(researcher, key(), { ...f.base, wins: 20, losses: 2 })); // only evaluators judge fitness
    assert.throws(() => f.fitness.report(evaluator, key(), { ...f.base, wins: 20, losses: 2, verdict: 'adds-value' }));
    assert.throws(() => f.fitness.report(evaluator, key(), { ...f.base, wins: 60, losses: 30 })); // more than judged
    await assert.rejects(() => f.fitness.report(evaluator, key(), { ...f.base, periodTo: '2099-01-01', wins: 3, losses: 1 }), /future/);
    await assert.rejects(() => f.fitness.report(evaluator, key(), { ...f.base, botId: 'nobody', wins: 3, losses: 1 }), /not found/);
    const own = await f.org.evidence(owner, key(), { sourceId: (await f.evidence()).sourceId, kind: 'dataset', content: 'Owner-written results', publishedAt: '2025-01-01T00:00:00Z' });
    await assert.rejects(() => f.fitness.report(evaluator, key(), { ...f.base, wins: 3, losses: 1, evidenceId: own.id }), /verified/);
    await f.org.reviewEvidence(evaluator, key(), { evidenceId: own.id, status: 'verified' });
    await assert.rejects(() => f.fitness.report(owner, key(), { ...f.base, wins: 3, losses: 1, evidenceId: own.id }), /Independent/);
    const supported = await f.evidence(); // researcher-authored, evaluator-verified
    const ok = await f.fitness.report(evaluator, key(), { ...f.base, wins: 3, losses: 1, evidenceId: supported.evidenceId });
    assert.equal(ok.duplicate, false);
    await assert.rejects(() => f.db.transaction(tx => tx.query("UPDATE bot_fitness_reports SET verdict='adds-value'")));
    await f.db.transaction(tx => tx.query("UPDATE bots SET state='retired' WHERE id='trend-analyst'"));
    await assert.rejects(() => f.fitness.report(evaluator, key(), { ...f.base, wins: 1, losses: 2 }), /Retired/);
    assert.equal((await f.ops.verifyAudit(owner)).valid, true);
  } finally { await f.db.close(); }
});

test('history produces recommendations, never actions', async () => {
  const f = await setup(); try {
    await f.fitness.report(evaluator, key(), { ...f.base, wins: 4, losses: 18 });
    await f.fitness.report(evaluator, key(), { ...f.base, testName: 'eight-weeks-v2', wins: 3, losses: 19 });
    await f.fitness.report(evaluator, key(), { ...f.base, role: 'trend-analyst', baseline: 'always-hold', testName: 'manager-view', wins: 25, losses: 5 });
    const result = await f.fitness.query(owner, { botId: 'trend-analyst' });
    const byBaseline = Object.fromEntries(result.summary.map(s => [s.baseline, s]));
    assert.equal(byBaseline['always-neutral']!.recommendation, 'review-for-retraining-or-retirement');
    assert.equal(byBaseline['always-neutral']!.latestVerdict, 'worse-than-baseline');
    assert.equal(byBaseline['always-hold']!.recommendation, 'candidate-for-more-responsibility');
    assert.equal(result.reports.length, 3);
    assert.equal(result.reports[0]!.periodFrom, '2026-08-14');
    const bot = (await f.db.transaction(tx => tx.query("SELECT state,budget_paise FROM bots WHERE id='trend-analyst'"))).rows[0]!;
    assert.deepEqual([bot.state, String(bot.budget_paise)], ['school', '0']); // nothing changed automatically
    assert.equal(recommend([]), 'no-reports');
  } finally { await f.db.close(); }
});

test('a live report is computed from scored paper calls, can fail an active release, and raises an alert', async () => {
  const f = await fixture(); try {
    const e = await f.evidence();
    await f.org.bot(owner, key(), { id: 'momentum-rules', name: 'Rules', department: 'desk', specialty: 'momentum', method: 'rules', contribution: 'Live fixture', budgetPaise: '0' });
    const fitness = new BotFitness(f.db), releases = new BotReleases(f.db);
    const release = await releases.create(researcher, key(), { botId: 'momentum-rules', model: 'rules:top3', promptVersion: 'r1', codeFingerprint: 'a1b2c3d4e5f60718', notes: 'Rule' });
    const seen = await fitness.report(evaluator, key(), { botId: 'momentum-rules', role: 'allocator', baseline: 'equal-weight-basket', testName: 'backtest (seen)',
      periodFrom: '2022-08-01', periodTo: '2026-09-30', judged: 50, wins: 32, losses: 18, model: 'rules:top3' });
    await releases.evaluate(evaluator, key(), { releaseId: release.id, fitnessReportId: seen.id });
    await releases.stage(owner, key(), { releaseId: release.id, stage: 'active', reason: 'Backtest' });
    assert.deepEqual((await new OwnerAlerts(f.db, f.cfg).cycle(owner, key())).raised.filter(a => a.rule === 'release-failing-evaluation'), []);

    await assert.rejects(() => fitness.live(evaluator, key(), { botId: 'momentum-rules' }), says(/No scored live paper calls/));
    // 24 scored calls of this release on new days (6 right), a no-action call (ignored), and 2 right calls made before any release
    await f.db.transaction(async tx => {
      const call = async (action: string, correct: boolean, releaseId: string | null) => {
        const id = crypto.randomUUID();
        await tx.query(`INSERT INTO trade_signals(id,bot_id,symbol,action,horizon_days,conviction,thesis,invalidation,expires_at,model,prompt_version,author,content_hash,release_id,created_at)
          VALUES($1,'momentum-rules','DEMO',$2,30,'high','Rule','Rule',now()-interval '20 days','rules:top3','r1','trader',$4,$3,now()-interval '40 days')`, [id, action, releaseId, 'hash-' + id]);
        await tx.query(`INSERT INTO trade_signal_outcomes(id,signal_id,exit_price_paise,observed_at,move_bps,correct,evidence_id,evaluator)
          VALUES($1,$2,10000,now(),0,$3,$4,'evaluator')`, [crypto.randomUUID(), id, correct, e.evidenceId]);
      };
      for (let i = 0; i < 24; i++) await call(i % 2 ? 'exit' : 'enter-long', i < 6, release.id);
      await call('no-action', true, release.id);
      for (let i = 0; i < 2; i++) await call('enter-long', true, null);
    });

    const live = await fitness.live(evaluator, key(), { botId: 'momentum-rules', releaseId: release.id });
    assert.equal(live.verdict, 'worse-than-baseline'); // 6 right, 18 wrong: p ~ 0.011
    const stored = (await fitness.query(owner, { botId: 'momentum-rules' })).reports[0]!;
    assert.deepEqual([stored.testName, stored.baseline, stored.judged, stored.wins, stored.losses, stored.model], ['live-paper release v1', 'cash', 24, 6, 18, 'rules:top3']);
    assert.equal((await fitness.live(evaluator, key(), { botId: 'momentum-rules', releaseId: release.id })).duplicate, true); // same numbers, nothing new
    await fitness.live(owner, key(), { botId: 'momentum-rules' }); // every release: 26 actionable calls, 8 right (no-action is not counted)
    const all = (await fitness.query(owner, { botId: 'momentum-rules' })).reports[0]!;
    assert.deepEqual([all.testName, all.judged, all.wins, all.model], ['live-paper all releases', 26, 8, null]);
    assert.throws(() => fitness.live(researcher, key(), { botId: 'momentum-rules' }));

    const evaluation = await releases.evaluate(evaluator, key(), { releaseId: release.id, fitnessReportId: live.id });
    assert.equal(evaluation.activeEligible, false);
    const raised = (await new OwnerAlerts(f.db, f.cfg).cycle(owner, key())).raised.filter(a => a.rule === 'release-failing-evaluation');
    assert.deepEqual(raised.map(a => a.subject), ['momentum-rules/v1']);
    assert.equal((await releases.view(owner, { botId: 'momentum-rules' })).active, release.id); // the owner decides; nothing was rolled back
  } finally { await f.db.close(); }
});

test('fitness routes are registered and guarded by role', async () => {
  const { cfg } = config(), db = await Database.open(), app = await createApp(cfg, db, true);
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const call = (path: string, role: string, body: unknown) => fetch(base + '/v1' + path, { method: 'POST', body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key(), Authorization: 'Bearer ' + cfg.principals.find(p => p.role === role)!.token } });
    assert.equal((await call('/bots/fitness/query', 'researcher', { botId: 'none' })).status, 201);
    assert.equal((await call('/bots/fitness', 'researcher', { botId: 'none' })).status, 403);
    assert.equal((await call('/bots/fitness/query', 'trader', { botId: 'none' })).status, 403);
  } finally { await app.close(); await db.close(); }
});
