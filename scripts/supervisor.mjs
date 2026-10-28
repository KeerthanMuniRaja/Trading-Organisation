// The supervisor (OPS-03): runs the organisation's day so no person has to. Owner-started and never installed by
// itself: run it in a terminal, or register it with the operating system's scheduler if the owner chooses to.
//   node scripts/supervisor.mjs               keep running: readiness 09:00 IST, cycle 16:05 IST, backup Fridays
//   node scripts/supervisor.mjs --once cycle  one job now and exit (readiness | cycle | backup | news)
// Between the daily jobs it polls every enabled news feed every NEWS_MINUTES, on any day (news never stops).
//   node scripts/supervisor.mjs --plan        the next jobs it would run, and stop
// On trading days only: weekends are skipped, and so are holidays listed in the owner's .local/nse-holidays.json.
// The cycle runs with the local model when one is configured and answers. If the backend is down the supervisor starts
// it (with only .env settings) and stops it again afterwards. Every job is logged to .local/supervisor/<day>.jsonl.
// Started late (the laptop slept through 16:05, or the supervisor was not running), it catches up today's jobs that are
// still useful, at most twice each. A job failing unexpectedly is logged and the supervisor carries on. A heartbeat in
// .local/supervisor/heartbeat.json, refreshed every minute, lets readiness and the status screen tell it is alive.
import { spawn } from 'node:child_process';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHolidays } from './readiness.mjs';
import { enabledFeeds, feedCommand } from './organisation-cycle.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const JOBS = [{ id: 'readiness', at: [9, 0] }, { id: 'cycle', at: [16, 5] }, { id: 'backup', at: [16, 45], weekday: 5 }];
// NEWS-03: news does not stop for weekends, holidays or the night. Between the daily jobs the supervisor polls every
// enabled feed this often (each feed's own poll interval and back-off still apply), so headlines are collected before
// the publishers' feeds roll them off. SUPERVISOR_NEWS_MINUTES sets it (15-240); 0 turns it off.
export const NEWS_MINUTES = 30;
export function newsMinutes(env = process.env) {
  if (env.SUPERVISOR_NEWS_MINUTES === undefined || env.SUPERVISOR_NEWS_MINUTES === '') return NEWS_MINUTES;
  const n = Number(env.SUPERVISOR_NEWS_MINUTES);
  return n === 0 ? 0 : Number.isInteger(n) && n >= 15 && n <= 240 ? n : NEWS_MINUTES;
}
/** The next news poll strictly after `now`, on the clock (every `minutes`, any day); null when turned off. */
export function nextNews(now, minutes = NEWS_MINUTES) {
  if (!minutes) return null;
  const step = minutes * 60_000, at = Math.floor(now / step) * step + step;
  return { id: 'news', at, day: indiaDay(at).day };
}
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

export const HEARTBEAT_STALE_MS = 5 * 60_000, STUCK_AFTER_MS = 10 * 60_000;
/** The supervisor's heartbeat, written every minute while it runs (also during a long cycle). */
export async function heartbeat(root = ROOT, now = Date.now()) {
  try {
    const beat = JSON.parse(await readFile(join(root, '.local', 'supervisor', 'heartbeat.json'), 'utf8'));
    const age = now - Date.parse(beat.at);
    // alive but not scheduling: a job was due over 10 minutes ago and nothing is running (28 Oct: news stopped for hours)
    const overdue = !beat.running && beat.nextAt && now - Date.parse(beat.nextAt) > STUCK_AFTER_MS;
    return { state: age > HEARTBEAT_STALE_MS ? 'stale' : overdue ? 'stuck' : 'alive', ageSeconds: Math.round(age / 1000), running: beat.running ?? null,
      next: beat.next ?? null, nextAt: beat.nextAt ?? null };
  } catch { return { state: 'never' }; }
}

/** The commands for a job, given whether the backend and the model answered, and which model (if any) the supervisor may
 *  start itself (MODEL_AUTOSTART). Pure, so it is tested. */
export function commands(job, { backendUp, modelUp, modelAuto = null, feeds = [], decisionHealth = null }) {
  const npm = s => ({ cmd: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: ['run', ...s] });
  // the backend is started directly (no shell), so the supervisor holds its real process and can stop exactly it
  const start = backendUp ? [] : [{ cmd: process.execPath, args: ['--env-file=.env', join('backend', 'dist', 'src', 'main.js')], background: true, id: 'start-backend' }];
  const stop = backendUp ? [] : [{ id: 'stop-backend', stop: true }];
  if (job === 'readiness') return [...start, { ...npm(['readiness']), id: 'readiness' }, ...stop];
  // news is submitted as evidence, so the backend must be up; with no enabled feed there is nothing to start
  if (job === 'news') return feeds.length ? [...start, ...feeds.map(f => ({ ...feedCommand(f, ROOT), id: 'news-' + f.slice(5, -5) })), ...stop]
    : [{ id: 'news', skip: 'no feed is enabled (.local/feed-*.json with "enabled": true)' }];
  if (job === 'cycle') {
    // the model is started for the cycle only when the owner named one to start, and stopped again afterwards
    const startModel = !modelUp && modelAuto ? [{ cmd: process.execPath, args: ['--env-file=.env', join('scripts', 'local-model.mjs'), 'serve', modelAuto],
      model: true, id: 'start-model' }] : [];
    const withModel = modelUp || !!startModel.length;
    // MODEL-UPGRADE-01: the decision model (passed our exams) for the debate and TradingAgents; optional, so the cycle
    // runs on the usual model if it does not come up
    const startDecision = withModel && decisionHealth ? [{ cmd: process.execPath, args: ['--env-file=.env', join('scripts', 'local-model.mjs'), 'serve', 'decision'],
      model: true, optional: true, health: decisionHealth, id: 'start-decision-model' }] : [];
    return [...start, ...startModel, ...startDecision, { ...npm(withModel ? ['cycle', '--', '--with-model'] : ['cycle']), id: 'cycle' },
      ...(startModel.length || startDecision.length ? [{ id: 'stop-model', stopModel: true }] : []), ...stop];
  }
  // a backup needs the database closed; a backend someone else started is never stopped by the supervisor
  if (job === 'backup') return backendUp ? [{ id: 'backup', skip: 'the backend is running and was not started by the supervisor; stop it to let the weekly backup run' }]
    : [{ ...npm(['backup', '--', 'create']), id: 'backup' }];
  throw new Error(`Unknown job "${job}" (readiness, cycle, backup, news)`);
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

/** Only npm needs a shell on Windows. Node itself must not get one: its path ("C:\Program Files\nodejs\node.exe") would
 *  be split at the space, which broke every news poll on 28 Oct ("'C:\Program' is not recognized"). */
export function needsShell(step, platform = process.platform) {
  return platform === 'win32' && !step.background && /(^|[\\/])npm(\.cmd)?$/i.test(step.cmd);
}

function run(step, env) {
  return new Promise(done => {
    // the backend itself is started without a shell, so its pid is the backend's own
    const child = spawn(step.cmd, step.args, { cwd: ROOT, env, windowsHide: true, shell: needsShell(step),
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

/** The decision model's health URL when the upgrade passed our exams and its weights are on this machine, else null. */
export async function decisionServerHealth(root = ROOT) {
  try {
    const routing = JSON.parse(await readFile(join(root, '.local', 'models', 'routing.json'), 'utf8'));
    const pins = JSON.parse(await readFile(join(root, '.local', 'models', 'pins.json'), 'utf8'));
    if (!routing?.decision?.baseUrl || !pins?.decision?.file || !existsSync(join(root, '.local', 'models', pins.decision.file))) return null;
    return modelHealthUrl(routing.decision.baseUrl);
  } catch { return null; }
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
  const decisionHealth = job === 'cycle' ? await decisionServerHealth(ROOT) : null;
  let started = null, ok = true;
  const models = [];
  const feeds = job === 'news' ? await enabledFeeds(ROOT) : [];
  for (const step of commands(job, { backendUp, modelUp, modelAuto, feeds, decisionHealth })) {
    if (step.skip) { await log({ job, step: step.id, ok: true, skipped: step.skip }); continue; }
    if (step.model) {
      const m = await startModel(step, childEnv(env));
      models.push({ ...m, health: step.health ?? health });
      const up = await waitFor(step.health ?? health, true, 10 * 60_000); // loading the weights takes a while on a laptop
      await log({ job, step: step.id, ok: up, ...(step.optional && !up ? { note: 'optional: the cycle uses the usual model' } : {}) });
      if (!up && !step.optional) { ok = false; break; }
      continue;
    }
    if (step.stopModel) {
      for (const m of models) for (const pid of [m.server, m.wrapper]) if (pid) { try { process.kill(pid); } catch { /* already gone */ } }
      const down = await Promise.all(models.map(m => waitFor(m.health, false, 30_000)));
      await log({ job, step: step.id, ok: down.every(Boolean) });
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
    // a NO-GO, a failed cycle step or one feed failing is logged, not fatal (the other feeds still poll)
    if (r.code !== 0 && step.id !== 'readiness' && step.id !== 'cycle' && !step.id.startsWith('news-')) { ok = false; break; }
    if (r.code !== 0) ok = false;
  }
  // a model this job started is never left running, whatever happened in between
  for (const m of models) for (const pid of [m.server, m.wrapper]) if (pid) { try { process.kill(pid); } catch { /* already gone */ } }
  return ok;
}

/** OPS-04: a machine that handed the organisation over (scripts/handover.mjs) must not run it again by accident: two
 *  machines would grow two databases that cannot be merged. Returns why it must not start, or null. */
export function handedOver(root = ROOT, args = []) {
  const path = join(root, '.local', 'handover.json');
  if (!existsSync(path) || args.includes('--take-back')) return null;
  let to = 'another machine';
  try { to = JSON.parse(readFileSync(path, 'utf8')).to ?? to; } catch { /* still handed over */ }
  return `This machine handed the organisation over to ${to}. Run it on one machine only. To run it here again, first stop it there, `
    + 'run "npm run handover" there, pull the data here, then start with: npm run supervisor -- --take-back';
}

/** OPS-05: a second supervisor must not start while a healthy one runs (two would run every job twice). A stale or
 *  stuck one does not count, so a replacement can always take over. */
export function anotherRunning(beat, { now = Date.now(), self = process.pid, exists = pidExists } = {}) {
  if (!beat || beat.pid === self) return null;
  const age = now - Date.parse(beat.at);
  const overdue = !beat.running && beat.nextAt && now - Date.parse(beat.nextAt) > STUCK_AFTER_MS;
  return age <= HEARTBEAT_STALE_MS && !overdue && exists(beat.pid) ? beat.pid : null;
}

/** OPS-05 watchdog: true when the scheduling loop should have started a job over STUCK_AFTER_MS ago and nothing runs. */
export function watchdogDue(state, now = Date.now()) {
  return !state.running && !!state.nextAt && now - Date.parse(state.nextAt) > STUCK_AFTER_MS;
}

function pidExists(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

async function main() {
  const args = process.argv.slice(2);
  const refused = handedOver(ROOT, args);
  if (refused) throw new Error(refused);
  if (!args.includes('--plan') && !args.includes('--once')) {
    let beat = null;
    try { beat = JSON.parse(readFileSync(join(ROOT, '.local', 'supervisor', 'heartbeat.json'), 'utf8')); } catch { /* first start */ }
    const other = anotherRunning(beat);
    if (other) throw new Error(`Another supervisor is already running (pid ${other}); not starting a second one`);
  }
  if (args.includes('--take-back')) await rm(join(ROOT, '.local', 'handover.json'), { force: true });
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
  setInterval(async () => {
    // the watchdog: alive but not scheduling (28 Oct: news stopped for hours). Under a scheduled task (--managed) exit
    // and let the task restart it; otherwise start a fresh supervisor first, so the organisation never just stops
    if (watchdogDue(state)) {
      await log({ job: 'supervisor', step: 'watchdog', ok: false, note: `${state.next} was due at ${state.nextAt} and did not start: restarting` }).catch(() => {});
      if (!args.includes('--managed')) {
        spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], { cwd: ROOT, env: process.env, detached: true, stdio: 'ignore', windowsHide: true }).unref();
      }
      process.exit(1);
    }
    await beat();
  }, 60_000);
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
    // the next daily job, unless a news poll comes first (a daily job is never skipped for news: news only fills the gaps)
    const [daily] = nextRuns(Date.now(), hol), news = nextNews(Date.now(), newsMinutes());
    const next = news && news.at < daily.at ? news : daily;
    Object.assign(state, { next: next.id, nextAt: new Date(next.at).toISOString() });
    await beat();
    if (next.id !== 'news') await log({ job: 'supervisor', step: 'waiting', next: next.id, at: new Date(next.at).toISOString() });
    while (Date.now() < next.at) await new Promise(r => setTimeout(r, Math.min(60_000, next.at - Date.now())));
    await guarded(next.id);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // exit hard: the heartbeat timer would otherwise keep a supervisor that no longer schedules looking alive
  main().catch(error => { console.error(error.message); process.exit(1); });
}
