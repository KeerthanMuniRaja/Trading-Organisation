// Live fitness (FITNESS-02), run daily by the organisation cycle with the evaluator credential: for every bot with
// scored paper calls, the backend computes a fitness report from those calls (for its active release when it has one).
// Once that report has enough evidence for a verdict, the active release is re-evaluated with it, so a release that
// stops working on new days loses its eligibility and the owner is alerted. Nothing is rolled back automatically.
//   node --env-file=.env scripts/live-fitness.mjs
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { settings } from './deliver-alerts.mjs';

export async function run(env = process.env, { fetchImpl = fetch, now = new Date() } = {}) {
  const s = settings(env);
  const call = async (method, path, body, keyParts) => {
    const headers = { Authorization: 'Bearer ' + s.token, 'Content-Type': 'application/json' };
    if (keyParts) headers['Idempotency-Key'] = 'livefit-' + createHash('sha256').update(JSON.stringify(keyParts)).digest('hex').slice(0, 48);
    const r = await fetchImpl(s.base + path, { method, headers, redirect: 'error', ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text();
    return { status: r.status, ok: r.ok, body: text ? JSON.parse(text) : null };
  };
  const day = now.toISOString().slice(0, 10);
  const bots = await call('GET', '/v1/bots');
  if (!bots.ok) throw new Error(`/v1/bots refused (HTTP ${bots.status})`);
  const results = [];
  for (const bot of bots.body.filter(b => b.state !== 'retired')) {
    const view = await call('POST', '/v1/releases/view', { botId: bot.id });
    const active = view.ok ? view.body.active : null;
    const report = await call('POST', '/v1/bots/fitness/live', { botId: bot.id, ...(active ? { releaseId: active } : {}) }, ['live', bot.id, active, day]);
    if (report.status === 409) continue; // no scored calls yet
    if (!report.ok) { results.push({ botId: bot.id, state: 'failed', reason: `HTTP ${report.status}` }); continue; }
    const row = { botId: bot.id, releaseId: active, verdict: report.body.verdict, pValue: report.body.pValue ?? null, newReport: !report.body.duplicate };
    if (active && report.body.verdict !== 'insufficient-evidence') {
      const evaluation = await call('POST', '/v1/releases/evaluations', { releaseId: active, fitnessReportId: report.body.id }, ['evaluate', active, report.body.id]);
      row.evaluation = evaluation.ok ? { activeEligible: evaluation.body.activeEligible } : { failed: `HTTP ${evaluation.status}` };
    }
    results.push(row);
  }
  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().then(results => {
    console.log(JSON.stringify(results, null, 2));
    if (results.some(r => r.state === 'failed' || r.evaluation?.failed)) process.exitCode = 1;
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
