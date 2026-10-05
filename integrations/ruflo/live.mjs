import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireRuntime, RUFLO_VERSION } from './runtime.mjs';
import { RufloCoordinator } from './coordinator.mjs';
import { createBackendClient, mirrorOnce, failureCode } from './mirror.mjs';

// Uses a fresh in-memory backend, generated test credentials and retained test
// Ruflo state. It never loads .env, the owner's signing key or the paper database.
const root = dirname(fileURLToPath(import.meta.url));
process.chdir(resolve(root, '../..'));
await mkdir(join(root, '.state'), { recursive: true });
let fixture, app, coordinator, stateDir;
let phase = 'runtime-preflight';
let report;
try {
  await requireRuntime();
  const { createApp } = await import('../../backend/dist/src/app.js');
  const helpers = await import('../../backend/dist/test/helpers.js');
  fixture = await helpers.fixture();
  const { owner, researcher, evaluator, key, bars } = helpers;
  const evidence = await fixture.evidence();
  await fixture.org.bot(owner, key(), { id: 'bot-one', name: 'Integration fixture', department: 'research', specialty: 'coordination', method: 'test-v1', contribution: 'Synthetic integration test', budgetPaise: '10000' });
  const lesson = await fixture.org.lesson(researcher, key(), { botId: 'bot-one', evidenceId: evidence.evidenceId, content: 'Retain independent evaluation records.' });
  await fixture.org.verifyLesson(evaluator, key(), { lessonId: lesson.id });
  await fixture.org.school(owner, key(), { botId: 'bot-one', lessonIds: [lesson.id] });
  const dataset = await fixture.research.dataset(owner, key(), { evidenceId: evidence.evidenceId, training: bars(30, 10000), holdout: bars(30, 13000, 30) });
  const experiment = await fixture.research.experiment(researcher, key(), { botId: 'bot-one', datasetId: dataset.id, hypothesis: 'Software integration fixture; no inference or trading.' });
  app = await createApp(fixture.cfg, fixture.db, true);
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const token = fixture.cfg.principals.find(p => p.role === 'coordinator').token;
  const client = createBackendClient({ base, token });
  assert.equal((await fetch(base + '/v1/treasury', { headers: { Authorization: 'Bearer ' + token } })).status, 403);
  stateDir = await mkdtemp(join(root, '.state', 'live-'));
  phase = 'api-to-ruflo-create';
  assert.deepEqual(await mirrorOnce({ client, stateDir }), { taskCount: 1, created: 1, completed: 0 });
  coordinator = await RufloCoordinator.open({ stateDir });
  assert.equal((await coordinator.getResearchTask(experiment.id)).status, 'pending');
  await coordinator.close(); coordinator = undefined;
  phase = 'application-evaluation';
  const research = (await fixture.research.claim(researcher)).job;
  await fixture.research.complete(researcher, key(), { jobId: research.id, leaseToken: research.leaseToken, result: { candidate: { kind: 'momentum', lookback: 2 }, trainingReport: { selectedScoreBps: 10, trials: [{ lookback: 2, netReturnBps: 10 }] } } });
  const evaluation = (await fixture.research.claim(evaluator)).job;
  await fixture.research.complete(evaluator, key(), { jobId: evaluation.id, leaseToken: evaluation.leaseToken, result: { observations: 30, netReturnBps: 100, baselineReturnBps: 0, maxDrawdownBps: 10, turnover: 2, costBps: 15, datasetDigest: dataset.digest } });
  phase = 'api-to-ruflo-complete';
  assert.deepEqual(await mirrorOnce({ client, stateDir }), { taskCount: 1, created: 0, completed: 1 });
  phase = 'restart-and-replay';
  assert.deepEqual(await mirrorOnce({ client, stateDir }), { taskCount: 1, created: 0, completed: 0 });
  coordinator = await RufloCoordinator.open({ stateDir });
  assert.equal((await coordinator.getResearchTask(experiment.id)).status, 'completed');
  const store = JSON.parse(await readFile(join(stateDir, 'workspace', '.claude-flow', 'tasks', 'store.json'), 'utf8'));
  assert.equal(Object.keys(store.tasks).length, 1);
  assert.equal(Object.values(store.tasks)[0].result.authority, 'application-owned');
  phase = 'owner-notifications';
  await client.status({ state: 'degraded', code: 'MCP_UNAVAILABLE', taskCount: 1 });
  await client.status({ state: 'degraded', code: 'MCP_UNAVAILABLE', taskCount: 1 });
  await client.status({ state: 'healthy', code: 'SYNCED', taskCount: 1 });
  const status = await fixture.ops.status(owner);
  assert.equal(status.notifications.filter(n => n.summary.startsWith('integration.ruflo.')).length, 2);
  assert.equal((await fixture.treasury.snapshot(owner)).wallet1Paise, '0');
  assert.equal((await fixture.treasury.snapshot(owner)).wallet2Paise, '0');
  report = { status: 'passed', phase: 'complete', packageVersion: RUFLO_VERSION, stateDir,
    checks: ['actual MCP create/status/complete', 'real backend HTTP feed', 'restart without duplicate task', 'owner failure/recovery inbox', 'coordinator wallet access denied', 'zero financial transactions'],
    note: 'Synthetic integration fixture; does not validate a trading strategy or model.' };
} catch (error) {
  report = { status: 'failed', phase, packageVersion: RUFLO_VERSION, code: failureCode(error), stateDir: stateDir ?? null,
    error: String(error.message).slice(0, 500), rpcCode: typeof error.cause?.code === 'number' ? error.cause.code : null,
    nextAction: error.code === 'OS_PROFILE_UNAVAILABLE'
      ? 'Run npm run test:ruflo:live from a normal terminal with a working OS user profile.'
      : 'Inspect the failing phase and retained test state. Do not bypass upstream security checks.' };
  process.exitCode = 1;
} finally {
  await coordinator?.close();
  await app?.close();
  await fixture?.db.close();
  if (report) {
    await writeFile(join(root, '.state', 'last-live.json'), JSON.stringify({ ...report, checkedAt: new Date().toISOString() }, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
}
