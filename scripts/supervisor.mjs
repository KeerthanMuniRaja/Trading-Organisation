// The supervisor (OPS-03): runs the organisation's day so no person has to. Owner-started and never installed by
// itself: run it in a terminal, or register it with the operating system's scheduler if the owner chooses to.
//   node scripts/supervisor.mjs               keep running: readiness 09:00 IST, cycle 16:05 IST, backup Fridays
//   node scripts/supervisor.mjs --once cycle  one job now and exit (readiness | cycle | backup)
//   node scripts/supervisor.mjs --plan        the next jobs it would run, and stop
// On trading days only: weekends are skipped, and so are holidays listed in the owner's .local/nse-holidays.json.
// The cycle runs with the local model when one is configured and answers. If the backend is down the supervisor starts
// it (with only .env settings) and stops it again afterwards. Every job is logged to .local/supervisor/<day>.jsonl.
// Started late (the laptop slept through 16:05, or the supervisor was not running), it catches up today's jobs that are
// still useful, at most twice each. A job failing unexpectedly is logged and the supervisor carries on. A heartbeat in
// .local/supervisor/heartbeat.json, refreshed every minute, lets readiness and the status screen tell it is alive.
import { spawn } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHolidays } from './readiness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const JOBS = [{ id: 'readiness', at: [9, 0] }, { id: 'cycle', at: [16, 5] }, { id: 'backup', at: [16, 45], weekday: 5 }];
const IST = 330 * 60_000;
// variables that would silently override .env if inherited from the parent process
const OVERRIDES = ['MAX_ORDER_PAISE', 'MAX_EXPOSURE_PAISE', 'MAX_REALISED_LOSS_PAISE', 'PRINCIPALS_JSON', 'DATABASE_PATH', 'API_URL'];

/** India date and weekday (0 Sunday … 6 Saturday) of a moment. */
export function indiaDay(ms) {
  const d = new Date(ms + IST);
  return { day: d.toISOString().slice(0, 10), weekday: d.getUTCDay() };
}

export function tradingDay(day, weekday, holidays) {
  return weekday !== 0 && weekday !== 6 && !holidays.has(day);
}

/** The next run of each job strictly after `now`: [{ id, at (ms), day }], soonest first. */
export function nextRuns(now, holidays = new Set(), jobs = JOBS) {
  const out = [];
  for (const job of jobs) {
    for (let offset = 0; offset < 30; offset++) {
      const { day, weekday } = indiaDay(now + offset * 86_400_000);
      const at = Date.parse(`${day}T00:00:00Z`) - IST + (job.at[0] * 60 + job.at[1]) * 60_000;
      if (at > now && tradingDay(day, weekday, holidays) && (job.weekday === undefined || job.weekday === weekday)) { out.push({ id: job.id, at, day }); break; }
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

export const MAX_ATTEMPTS = 2;   // a job that cannot even start (e.g. the backend will not come up) is tried twice a day, not forever
const MAIN = new Set(['readiness', 'cycle', 'backup']);

/** Today's jobs the supervisor should still run now, because the laptop was asleep or the supervisor was not running at
 *  their time: readiness only while it still helps (before the close), the cycle any time after 16:05 IST. Pure. */
export function catchUp(now, holidays, done, attempts = new Map()) {
  const { day, weekday } = indiaDay(now);
  if (!tradingDay(day, weekday, holidays)) return [];
  const minutes = Math.floor(((now + IST) % 86_400_000) / 60_000);
  const due = job => !done.has(`${job}:${day}`) && (attempts.get(`${job}:${day}`) ?? 0) < MAX_ATTEMPTS;
  return [...(minutes >= 9 * 60 && minutes < 15 * 60 + 30 && due('readiness') ? ['readiness'] : []),
    ...(minutes >= 16 * 60 + 5 && due('cycle') ? ['cycle'] : [])];
}

/** What already happened on an India day: jobs whose main step finished (the supervisor's log, or a cycle journal with
 *  finishedAt, also when the owner ran it by hand) and how often each job was started. */
export async function history(day, root = ROOT) {
  const done = new Set(), attempts = new Map();
  const path = join(root, '.local', 'supervisor', day + '.jsonl');
  if (existsSync(path)) for (const line of (await readFile(path, 'utf8')).split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!MAIN.has(e.job)) continue;
    if (e.step === e.job) done.add(`${e.job}:${day}`);
    if (e.step === 'start') attempts.set(`${e.job}:${day}`, (attempts.get(`${e.job}:${day}`) ?? 0) + 1);
  }
  // the cycle journal is named by its UTC date, which is the India date from 05:30 to midnight IST
  try { if (JSON.parse(await readFile(join(root, '.local', 'cycles', day + '.json'), 'utf8')).finishedAt) done.add(`cycle:${day}`); } catch { /* none */ }
  return { done, attempts };
}

export const HEARTBEAT_STALE_MS = 5 * 60_000;
/** The supervisor's heartbeat, written every minute while it runs (also during a long cycle). */
export async function heartbeat(root = ROOT, now = Date.now()) {
  try {
    const beat = JSON.parse(await readFile(join(root, '.local', 'supervisor', 'heartbeat.json'), 'utf8'));
    const age = now - Date.parse(beat.at);
    return { state: age <= HEARTBEAT_STALE_MS ? 'alive' : 'stale', ageSeconds: Math.round(age / 1000), running: beat.running ?? null, next: beat.next ?? null, nextAt: beat.nextAt ?? null };
  } catch { return { state: 'never' }; }
}

/** The commands for a job, given whether the backend and the model answered, and which model (if any) the supervisor may
 *  start itself (MODEL_AUTOSTART). Pure, so it is tested. */
export function commands(job, { backendUp, modelUp, modelAuto = null }) {
  const npm = s => ({ cmd: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: ['run', ...s] });
  // the backend is started directly (no shell), so the supervisor holds its real process and can stop exactly it
  const start = backendUp ? [] : [{ cmd: process.execPath, args: ['--env-file=.env', join('backend', 'dist', 'src', 'main.js')], background: true, id: 'start-backend' }];
  const stop = backendUp ? [] : [{ id: 'stop-backend', stop: true }];
  if (job === 'readiness') return [...start, { ...npm(['readiness']), id: 'readiness' }, ...stop];
  if (job === 'cycle') {
    // the model is started for the cycle only when the owner named one to start, and stopped again afterwards
    const startModel = !modelUp && modelAuto ? [{ cmd: process.execPath, args: ['--env-file=.env', join('scripts', 'local-model.mjs'), 'serve', modelAuto],
      model: true, id: 'start-model' }] : [];
    const withModel = modelUp || !!startModel.length;
    return [...start, ...startModel, { ...npm(withModel ? ['cycle', '--', '--with-model'] : ['cycle']), id: 'cycle' },
      ...(startModel.length ? [{ id: 'stop-model', stopModel: true }] : []), ...stop];
  }
  // a backup needs the database closed; a backend someone else started is never stopped by the supervisor
  if (job === 'backup') return backendUp ? [{ id: 'backup', skip: 'the backend is running and was not started by the supervisor; stop it to let the weekly backup run' }]
    : [{ ...npm(['backup', '--', 'create']), id: 'backup' }];
  throw new Error(`Unknown job "${job}" (readiness, cycle, backup)`);
}

/** The environment for a child: the parent's, minus anything that would override .env. */
export function childEnv(parent = process.env) {
  const env = { ...parent };
  for (const k of OVERRIDES) delete env[k];
  return env;
}

async function reachable(url, ms = 3000) {
  try { return (await fetch(url, { signal: AbortSignal.timeout(ms) })).ok; } catch { return false; }
}

async function holidays(root = ROOT) {
  const path = join(root, '.local', 'nse-holidays.json');
  if (!existsSync(path)) return new Set();
  const parsed = parseHolidays(await readFile(path, 'utf8'));
  return parsed.error ? new Set() : parsed.days;
}

async function log(entry, root = ROOT) {
  const dir = join(root, '.local', 'supervisor');
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, indiaDay(Date.now()).day + '.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

function run(step, env) {
  return new Promise(done => {
    // npm needs a shell on Windows; the backend itself is started without one, so its pid is the backend's own
    const child = spawn(step.cmd, step.args, { cwd: ROOT, env, windowsHide: true, shell: process.platform === 'win32' && !step.background,
      stdio: step.background ? 'ignore' : ['ignore', 'pipe', 'pipe'], detached: !!step.background });
    if (step.background) { child.unref(); done({ code: 0, pid: child.pid }); return; }
    let tail = '';
    const keep = c => { tail = (tail + c).slice(-2000); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    child.on('close', code => done({ code: code ?? 1, tail: tail.trim().split('\n').slice(-3).join(' | ') }));
    child.on('error', () => done({ code: 127, tail: 'could not start ' + step.cmd }));
  });
}

async function waitFor(url, up, ms = 60_000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 2000))) if (await reachable(url) === up) return true;
  return false;
}

/** llama.cpp's public health endpoint for an OpenAI-compatible base URL (its /v1/models needs the API key). */
export function modelHealthUrl(base) {
  return base ? base.replace(/\/+$/, '').replace(/\/v1$/, '') + '/health' : null;
}

/** Starts the pinned local model server (scripts/local-model.mjs serve) and returns the pids to stop later. */
function startModel(step, env) {
  return new Promise(done => {
    const child = spawn(step.cmd, step.args, { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    let buffer = '';
    const timer = setTimeout(() => done({ wrapper: child.pid, server: null }), 30_000);
    child.stdout.on('data', chunk => {
      buffer += chunk;
      try { const line = JSON.parse(buffer.split('\n')[0]); clearTimeout(timer); child.unref(); done({ wrapper: child.pid, server: line.pid ?? null }); } catch { /* wait for the line */ }
    });
    child.on('error', () => { clearTimeout(timer); done({ wrapper: null, server: null }); });
  });
}

/** Runs one job end to end and logs each step. Returns true when every step succeeded. */
export async function runJob(job, env = process.env) {
  await log({ job, step: 'start' });
  const api = (env.API_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
  const backendUp = await reachable(api + '/v1/health');
  const health = modelHealthUrl(env.HERMES_MODEL_BASE_URL);
  const modelUp = !!health && await reachable(health);
  const modelAuto = health && /^[A-Za-z0-9._-]{1,80}$/.test(env.MODEL_AUTOSTART ?? '') ? env.MODEL_AUTOSTART : null;
  let started = null, model = null, ok = true;
  for (const step of commands(job, { backendUp, modelUp, modelAuto })) {
    if (step.skip) { await log({ job, step: step.id, ok: true, skipped: step.skip }); continue; }
    if (step.model) {
      model = await startModel(step, childEnv(env));
      const up = await waitFor(health, true, 10 * 60_000); // loading the weights takes a while on a laptop
      await log({ job, step: step.id, ok: up });
      if (!up) { ok = false; break; }
      continue;
    }
    if (step.stopModel) {
      for (const pid of [model?.server, model?.wrapper]) if (pid) { try { process.kill(pid); } catch { /* already gone */ } }
      await log({ job, step: step.id, ok: await waitFor(health, false, 30_000) });
      continue;
    }
    if (step.stop) {
      // only the backend this job started is ever stopped
      if (started) { try { process.kill(started); } catch { /* already gone */ } }
      const down = await waitFor(api + '/v1/health', false, 30_000);
      await log({ job, step: step.id, ok: down });
      if (!down) { ok = false; break; }
      continue;
    }
    const r = await run(step, childEnv(env));
    if (step.background) {
      started = r.pid;
      const up = await waitFor(api + '/v1/health', true);
      await log({ job, step: step.id, ok: up });
      if (!up) { ok = false; break; }
      continue;
    }
    await log({ job, step: step.id, ok: r.code === 0, exitCode: r.code, tail: r.tail });
    if (r.code !== 0 && step.id !== 'readiness' && step.id !== 'cycle') { ok = false; break; } // a NO-GO or a failed step is logged, not fatal
    if (r.code !== 0) ok = false;
  }
  // a model this job started is never left running, whatever happened in between
  if (model) for (const pid of [model.server, model.wrapper]) if (pid) { try { process.kill(pid); } catch { /* already gone */ } }
  return ok;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--plan')) {
    for (const r of nextRuns(Date.now(), await holidays())) console.log(`${r.id.padEnd(9)} ${new Date(r.at + IST).toISOString().slice(0, 16).replace('T', ' ')} IST`);
    return;
  }
  const once = args.indexOf('--once');
  if (once >= 0) { process.exitCode = await runJob(args[once + 1] ?? 'cycle') ? 0 : 1; return; }
  // the heartbeat runs on its own timer, so a long cycle does not make the supervisor look dead
  const state = { running: null, next: null, nextAt: null };
  const beat = () => mkdir(join(ROOT, '.local', 'supervisor'), { recursive: true })
    .then(() => writeFile(join(ROOT, '.local', 'supervisor', 'heartbeat.json'), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...state }) + '\n'))
    .catch(() => {});
  setInterval(beat, 60_000);
  // one job failing in an unexpected way is logged; the supervisor itself keeps going
  const guarded = async job => {
    state.running = job; await beat();
    try { await runJob(job); } catch (error) { await log({ job, step: 'crashed', ok: false, error: String(error?.message ?? error).slice(0, 300) }).catch(() => {}); }
    finally { state.running = null; await beat(); }
  };
  for (;;) {
    const hol = await holidays(), today = indiaDay(Date.now()).day;
    const { done, attempts } = await history(today);
    for (const job of catchUp(Date.now(), hol, done, attempts)) {
      await log({ job: 'supervisor', step: 'catch-up', next: job });
      await guarded(job);
    }
    const [next] = nextRuns(Date.now(), hol);
    Object.assign(state, { next: next.id, nextAt: new Date(next.at).toISOString() });
    await beat();
    await log({ job: 'supervisor', step: 'waiting', next: next.id, at: new Date(next.at).toISOString() });
    while (Date.now() < next.at) await new Promise(r => setTimeout(r, Math.min(60_000, next.at - Date.now())));
    await guarded(next.id);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
