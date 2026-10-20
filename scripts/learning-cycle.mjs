// The learning loop in the daily cycle (AUTO-02): every open learning workflow (source lesson -> transfer -> fresh
// assessment, see docs/learning-workflows.md) is advanced by one stage for whichever role it waits on, using the existing
// scoped knowledge worker, so the owner no longer runs worker terminals by hand. Reviews between stages stay separate
// decisions; workflows waiting on them are reported, never skipped silently. Needs the local model (cycle --with-model).
//   node --env-file=.env scripts/learning-cycle.mjs
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PER_ROLE = 5; // stages per role per cycle: bounded model use

async function active(env, role, fetchImpl) {
  const p = JSON.parse(env.PRINCIPALS_JSON || '[]').filter(x => x.role === role && !x.botId);
  if (p.length !== 1) throw new Error(`Configure exactly one ${role} credential`);
  const base = (env.API_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
  const r = await fetchImpl(base + '/v1/learning/workflows/active', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + p[0].token }, body: '{}' });
  if (!r.ok) throw new Error(`/v1/learning/workflows/active refused (HTTP ${r.status})`);
  return JSON.parse(await r.text()).workflows;
}

function worker(args) {
  return new Promise(done => {
    const child = spawn(process.execPath, [join(ROOT, 'scripts', 'run-knowledge.mjs'), ...args], { cwd: ROOT, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', c => { output = (output + c).slice(-4000); }); child.stderr.on('data', c => { output = (output + c).slice(-4000); });
    child.on('close', code => done({ code: code ?? 1, tail: output.trim().split('\n').slice(-2).join(' | ').slice(0, 300) }));
    child.on('error', () => done({ code: 127, tail: 'could not start the knowledge worker' }));
  });
}

export async function runLearning(env = process.env, { fetchImpl = fetch, run = worker } = {}) {
  const advanced = [], waiting = [], failed = [];
  for (const role of ['researcher', 'evaluator']) {
    const mine = await active(env, role, fetchImpl);
    for (const w of mine.filter(w => !w.actionable)) if (!waiting.some(x => x.workflowId === w.workflowId)) waiting.push({ workflowId: w.workflowId, state: w.state });
    for (const w of mine.filter(w => w.actionable).slice(0, PER_ROLE)) {
      const r = await run(['workflow-run', '--workflow-id', w.workflowId, '--role', role]);
      (r.code === 0 ? advanced : failed).push({ workflowId: w.workflowId, role, stage: w.state, ...(r.code === 0 ? {} : { reason: r.tail }) });
    }
  }
  // a workflow one role advanced is no longer "waiting" for the other
  const moved = new Set(advanced.map(a => a.workflowId));
  return { advanced, waiting: waiting.filter(w => !moved.has(w.workflowId)), failed };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runLearning().then(result => {
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.failed.length ? 1 : 0;
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
