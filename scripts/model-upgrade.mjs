// Model upgrade (MODEL-UPGRADE-01): a bigger decision model for the debate and TradingAgents, on THIS machine.
// 1. resolve: the largest candidate the RAM fits that exists, pinned to Hugging Face's published sha256 (local-model.mjs)
// 2. install: download and verify it (6-9 GB)
// 3. examine: serve it on its own port and run our debate exams against it (model_eval.py)
// 4. route: only if the exams say SHIP, write .local/models/routing.json; the supervisor then starts it for each cycle
//    and the cycle sends only the debate and TradingAgents to it (the 4B keeps the bulk work). Otherwise nothing changes.
//   node --env-file=.env scripts/model-upgrade.mjs            node scripts/model-upgrade.mjs --show
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PINS, ROUTING } from './local-model.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const lock = JSON.parse(readFileSync(join(root, 'config', 'local-model.lock.json'), 'utf8'));
const PY = join(root, '.local', 'replay-venv', process.platform === 'win32' ? 'Scripts\\python.exe' : 'bin/python');

/** The exam's verdict and report path from model_eval.py's output. */
export function parseExam(output) {
  const overall = /Overall:\s*(SHIP|DON'T SHIP)/.exec(output)?.[1] ?? null;
  const report = /Report:\s*(\S.*\.json)/.exec(output)?.[1]?.trim() ?? null;
  return { overall, report };
}

/** The routing record: written only for a SHIP verdict. */
export function routingFor(pin, port, exam, now = new Date()) {
  if (exam.overall !== 'SHIP') return null;
  return { decision: { key: pin.key, alias: pin.alias, baseUrl: `http://127.0.0.1:${port}/v1`, examReport: exam.report, examOverall: exam.overall,
    decidedAt: now.toISOString(), note: 'Used for the debate and TradingAgents only while its server answers; the 4B keeps the bulk work.' } };
}

const node = (args, opts = {}) => spawnSync(process.execPath, ['--env-file-if-exists=.env', join('scripts', 'local-model.mjs'), ...args],
  { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 6 * 3_600_000, ...opts });
const up = url => fetch(url, { signal: AbortSignal.timeout(3000) }).then(r => r.ok, () => false);
async function waitFor(url, want, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 3000))) if (await up(url) === want) return true;
  return false;
}

async function main() {
  if (process.argv.includes('--show')) {
    console.log(JSON.stringify({ pinned: JSON.parse(existsSync(PINS) ? readFileSync(PINS, 'utf8') : '{}').decision ?? null,
      routing: existsSync(ROUTING) ? JSON.parse(readFileSync(ROUTING, 'utf8')) : null }, null, 2));
    return;
  }
  const port = lock.decisionServer.port, health = `http://127.0.0.1:${port}/health`;
  if (await up(health)) throw new Error(`Something already answers on port ${port}; stop it first`);
  for (const [step, args] of [['resolve', ['resolve', 'decision']], ['install', ['install', 'decision']]]) {
    console.error(`${step}...`);
    const r = node(args, { stdio: ['ignore', 'pipe', 'inherit'] });
    if (r.status !== 0) throw new Error(`${step} failed; nothing was changed`);
  }
  const pin = JSON.parse(readFileSync(PINS, 'utf8')).decision;
  console.error(`Examining ${pin.alias} on port ${port} (its server loads first; the exams take a while on a laptop)...`);
  const server = spawn(process.execPath, ['--env-file-if-exists=.env', join('scripts', 'local-model.mjs'), 'serve', 'decision'],
    { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], detached: true });
  let serverPid = null;
  server.stdout.on('data', c => { try { serverPid = JSON.parse(String(c).split('\n')[0]).pid ?? serverPid; } catch { /* not the start line */ } });
  try {
    if (!await waitFor(health, true, 15 * 60_000)) throw new Error(`${pin.alias} did not start (see .local/models/server-decision.log)`);
    const exam = spawnSync(PY, [join('integrations', 'model-eval', 'model_eval.py'), '--tasks', 'debate', '--repeats', '1'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 3 * 3_600_000, maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, HERMES_MODEL_BASE_URL: `http://127.0.0.1:${port}/v1`, HERMES_MODEL: pin.alias } });
    const result = parseExam(`${exam.stdout ?? ''}\n${exam.stderr ?? ''}`);
    const routing = routingFor(pin, port, result);
    if (routing) await writeFile(ROUTING, JSON.stringify(routing, null, 2) + '\n');
    else await rm(ROUTING, { force: true });
    console.log(JSON.stringify({ model: pin.alias, exams: result.overall ?? 'no verdict', report: result.report,
      routed: !!routing, next: routing ? 'the supervisor starts it for each cycle; the debate and TradingAgents use it' : 'nothing changed: the 4B keeps every job' }));
  } finally {
    for (const pid of [serverPid, server.pid]) if (pid) { try { process.kill(pid); } catch { /* gone */ } }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
