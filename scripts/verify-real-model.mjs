import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fixture, key, owner, researcher, evaluator } from '../backend/dist/test/helpers.js';
import { createApp } from '../backend/dist/src/app.js';
import { ResearchDevelopment } from '../backend/dist/src/development.js';

// Real-inference check of the whole learning chain through the production worker CLI and the direct structured
// engine: article -> model lesson -> review -> cross-bot transfer -> fresh assessment -> backend grade.
// It uses an in-memory backend and ephemeral credentials; it never reads the persistent database or enables policy there.
const env0 = process.env, startedAt = new Date().toISOString();
const rubric = process.argv.includes('--methods') ? 'research-methods-v1' : 'research-basics-v1';
for (const name of ['HERMES_MODEL', 'HERMES_MODEL_BASE_URL', 'HERMES_MODEL_API_KEY'])
  if (!env0[name]) { console.error(`${name} is required (run: npm run model:local -- configure <model>)`); process.exit(1); }
const ARTICLE = 'Brokers raised execution fees this quarter. Analysts noted that strategies with high turnover now pay materially more ' +
  'in commissions and slippage. Several funds reported that gross returns overstated performance once these costs were deducted.';
let f, app, report;
const timings = [];
try {
  const models = await fetch(env0.HERMES_MODEL_BASE_URL.replace(/\/$/, '') + '/models', { headers: { Authorization: 'Bearer ' + env0.HERMES_MODEL_API_KEY } });
  assert.ok(models.ok, 'Local model server is not reachable; start it with npm run model:local -- serve <model>');
  f = await fixture();
  for (const id of ['mentor', 'student']) await f.org.bot(owner, key(), { id, name: id, department: 'research', specialty: id + '-costs',
    method: 'reasoning', contribution: 'Distinct verification role', budgetPaise: '0' });
  await f.org.sources(owner, key(), { id: 'publisher', name: 'Synthetic publisher', url: 'https://publisher.example', approved: true });
  const evidence = await f.org.observations().ingest(researcher, key(), { sourceId: 'publisher', url: 'https://publisher.example/fees',
    title: 'Execution fees rise', kind: 'article', content: ARTICLE, publishedAt: '2026-10-01T09:00:00Z' });
  await f.org.reviewEvidence(evaluator, key(), { evidenceId: evidence.id, status: 'verified' });
  await new ResearchDevelopment(f.db).configure(owner, key(), { expectedRevision: 0, enabled: true, maxPerDay: 10, maxLifetime: 100,
    maxTokensPerDay: 200000, model: { name: env0.HERMES_MODEL, baseUrl: env0.HERMES_MODEL_BASE_URL, engine: 'direct-structured-v1' } });
  app = await createApp(f.cfg, f.db, true); await app.listen(0, '127.0.0.1');
  const base = await app.getUrl(), token = role => f.cfg.principals.find(p => p.role === role).token;
  const api = async (role, method, path, body, idempotent = true) => {
    const response = await fetch(base + '/v1/' + path, { method, signal: AbortSignal.timeout(30000), headers: { Authorization: 'Bearer ' + token(role),
      'Content-Type': 'application/json', ...(idempotent ? { 'Idempotency-Key': key() } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.ok(response.ok, `${method} ${path} -> HTTP ${response.status}`);
    return response.json();
  };
  const { workflowId } = await api('owner', 'POST', 'learning/workflows', { mentorId: 'mentor', recipientId: 'student', evidenceId: evidence.id,
    researcherId: researcher.id, evaluatorId: evaluator.id, task: 'Apply the cost lesson to a fresh comparison of two allocation methods.',
    ...(rubric === 'research-methods-v1' ? { assessmentRubric: rubric } : {}) });
  const python = resolve('integrations/skfolio/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const baseEnv = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP'].filter(k => env0[k]).map(k => [k, env0[k]]));
  const step = role => new Promise((done, reject) => {
    const started = Date.now();
    const child = spawn(python, ['integrations/hermes/knowledge_worker.py', 'workflow-run', '--workflow-id', workflowId, '--role', role],
      { env: { ...baseEnv, API_URL: base, API_TOKEN: token(role), PYTHONIOENCODING: 'utf-8', PYTHONNOUSERSITE: '1', HERMES_ENABLED: 'true',
        HERMES_ENGINE: 'direct', HERMES_TIMEOUT_SECONDS: '300', HERMES_MODEL: env0.HERMES_MODEL, HERMES_MODEL_BASE_URL: env0.HERMES_MODEL_BASE_URL,
        HERMES_MODEL_API_KEY: env0.HERMES_MODEL_API_KEY }, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = '';
    const timer = setTimeout(() => child.kill(), 600000);
    child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { error += b; });
    child.once('close', code => { clearTimeout(timer); timings.push({ role, seconds: Math.round((Date.now() - started) / 100) / 10 });
      if (code !== 0) return reject(new Error(`${role} worker failed: ${error.slice(0, 400)}`));
      try { const value = JSON.parse(output); done(value.last.progress ?? value.last); } catch (e) { reject(e); } });
  });
  let progress = await step('researcher');
  assert.equal(progress.state, 'awaiting-source-review', 'source lesson stage');
  const sources = await api('owner', 'GET', 'learning/sources', undefined, false);
  const sourceProposal = sources.items.find(item => item.request_id === progress.links.source)?.proposal ?? null;
  assert.ok(sourceProposal && ARTICLE.includes(sourceProposal.quote), 'model lesson must quote the article exactly');
  // Fixture review: the backend already verified the exact quotation; this records acceptance for the verification only.
  await api('evaluator', 'POST', 'learning/sources/reviews', { requestId: progress.links.source, decision: 'accepted',
    reason: 'Verification fixture: quotation matches the article; lesson accepted to exercise transfer, not as investment judgement.' });
  progress = await step('researcher');
  assert.equal(progress.state, 'awaiting-transfer-review', 'transfer stage');
  await api('evaluator', 'POST', 'learning/knowledge/reviews', { requestId: progress.links.transfer, decision: 'accepted',
    reason: 'Verification fixture: plan cites the transferred lesson; accepted to exercise fresh assessment only.' });
  progress = await step('evaluator'); assert.equal(progress.state, 'assessment-answer', 'assessment issued');
  progress = await step('researcher'); assert.equal(progress.state, 'assessment-grade', 'assessment answered');
  progress = await step('evaluator'); assert.equal(progress.state, 'completed', 'assessment graded');
  const usage = await api('owner', 'GET', 'development/inference-usage', undefined, false);
  assert.equal(usage.last24Hours.reported, 3);
  assert.ok(usage.recent.every(r => r.outcome === 'completed' && r.engine === 'direct-structured-v1' && r.prompt_tokens > 0 && r.completion_tokens > 0));
  const graph = await api('owner', 'POST', 'learning/knowledge/graph', { botId: 'student' }, false);
  assert.equal((await f.treasury.snapshot(owner)).wallet1Paise, '0');
  assert.equal((await f.ops.verifyAudit(owner)).valid, true);
  const row = async (sql, id) => (await f.db.transaction(tx => tx.query(sql, [id]))).rows[0];
  const plan = (await row('SELECT proposal FROM bot_knowledge_proposals WHERE request_id=$1', progress.links.transfer))?.proposal ?? null;
  const answers = (await row('SELECT answers FROM knowledge_assessment_answers WHERE assessment_id=$1', progress.links.assessment))?.answers ?? null;
  report = { status: 'passed', startedAt, finishedAt: new Date().toISOString(), model: env0.HERMES_MODEL, engine: 'direct-structured-v1', rubric,
    realModelInference: true, workflowId, stageTimings: timings, assessment: progress.assessment,
    inference: usage.recent.map(r => ({ kind: r.kind, latencyMs: r.latency_ms, promptTokens: r.prompt_tokens, completionTokens: r.completion_tokens })),
    tokensLast24Hours: usage.last24Hours.reported_tokens, graph: { nodes: graph.nodes.length, edges: graph.edges.length },
    modelOutputs: { sourceLesson: sourceProposal, transferPlan: plan, assessmentAnswers: answers },
    reviews: 'Automated fixture acceptances; real deployment requires independent review judgement',
    scope: 'One synthetic article and four fresh synthetic cases on a local CPU model. Not market competence or demonstrated learning.' };
} catch (error) { report = { status: 'failed', startedAt, stageTimings: timings, message: error.message }; process.exitCode = 1; }
finally { if (app) await app.close(); if (f) await f.db.close(); }
await mkdir('.local', { recursive: true });
await writeFile(rubric === 'research-methods-v1' ? '.local/real-model-verification-methods.json' : '.local/real-model-verification.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
