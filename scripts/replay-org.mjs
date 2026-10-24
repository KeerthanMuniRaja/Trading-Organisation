// Fast-forward replay of the whole organisation (REPLAY-03): the real backend, the real daily cycle and the real desk
// scripts, run over a past stretch of trading days in an afternoon, on the replay clock (scripts/replay-clock.mjs and
// integrations/replay/sitecustomize.py). It tests how the organisation behaves over many days (proposals, reviews,
// fills, scoring, management, brakes, digests) without waiting for them. It never touches the live organisation:
//   - everything lives in .local/replay/: a separate checkout of the committed code (a git worktree), its own database,
//     its own freshly generated credentials and owner key, and its own copy of the price history;
//   - its backend listens on port 3100, not 3000, and the clock refuses any database that is not a replay one;
//   - no network: prices come from the copied history, cut at each replayed day; no feed is enabled; no model.
// Commands:
//   node scripts/replay-org.mjs prepare                       the workspace (worktree, build, settings, prices)
//   node scripts/replay-org.mjs run --from 2025-04-01 --to 2025-06-30 [--budget-paise 500000]
//        [--protections docs/policies/protections-suggested.json] [--autonomy docs/policies/autonomy-starter.json]
//        [--charter docs/policies/founder-charter.json]  (both parts at once, as `npm run charter -- set` applies them)
//        policies applied at the start, so a decision can be tried on the past before it is taken for real
//   node scripts/replay-org.mjs report                        the result of the last run
//   node scripts/replay-org.mjs clean                         remove the workspace
import { execFileSync, spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { existsSync, symlinkSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = join(ROOT, '.local', 'replay'), WS = join(HOME, 'workspace');
const CLOCK = join(HOME, 'clock.json'), FULL = join(HOME, 'prices-full'), REPORT = join(HOME, 'report.json');
const PORT = 3100, API = `http://127.0.0.1:${PORT}`;
const PY = join(ROOT, '.local', 'replay-venv', ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']));
const IST = 330 * 60_000;
// the live organisation's limits (from the 22 Oct run's limits banner), so the replay behaves like it
const LIMITS = { MAX_ORDER_PAISE: '500000', MAX_EXPOSURE_PAISE: '500000', MAX_REALISED_LOSS_PAISE: '100000', PAPER_FEE_BPS: '10', PAPER_SLIPPAGE_BPS: '5' };

/** India wall-clock time on a day, as an ISO instant. */
export const indiaTime = (day, hh, mm = 0) => new Date(Date.parse(`${day}T00:00:00Z`) - IST + (hh * 60 + mm) * 60_000).toISOString();

/** The trading days between two dates: the sessions present in the price history. */
export function sessions(bars, from, to) {
  return [...new Set(bars.map(b => b.date))].filter(d => d >= from && d <= to).sort();
}

/** The replay's own settings: fresh credentials and owner key, the live limits, port 3100, a replay database. */
export function replaySettings(publicKeyPem) {
  const roles = ['owner', 'researcher', 'evaluator', 'market', 'treasury', 'coordinator'];
  const principals = roles.map(role => ({ id: 'replay-' + role, role, token: randomBytes(32).toString('base64url') }));
  return ['APP_MODE=paper', 'HOST=127.0.0.1', `PORT=${PORT}`, `API_URL=${API}`, 'DATABASE_PATH=.data/replay-paper',
    `PRINCIPALS_JSON='${JSON.stringify(principals)}'`, `OWNER_PUBLIC_KEY_BASE64=${Buffer.from(publicKeyPem).toString('base64')}`,
    ...Object.entries(LIMITS).map(([k, v]) => `${k}=${v}`), 'PRICE_EVIDENCE_SOURCE=market-yahoo-daily', ''].join('\n');
}

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });

async function prepare() {
  if (existsSync(WS)) throw new Error(`${WS} exists: run "clean" first, or "run" to use it`);
  await mkdir(HOME, { recursive: true });
  sh('git', ['-c', 'safe.directory=*', 'worktree', 'add', '--detach', WS, 'HEAD'], { cwd: ROOT });
  symlinkSync(join(ROOT, 'node_modules'), join(WS, 'node_modules'), 'junction');
  sh(process.execPath, [join(WS, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'backend/tsconfig.json'], { cwd: WS });
  const keys = generateKeyPairSync('ed25519');
  await mkdir(join(WS, '.local'), { recursive: true });
  await writeFile(join(WS, '.local', 'owner-signing-key.pem'), keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  await writeFile(join(WS, '.env'), replaySettings(keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()), { mode: 0o600 });
  // the full price history, which each replayed day cuts at its own date; and the R&D and method knowledge (no feeds)
  await cp(join(ROOT, '.local', 'trading-desk', 'daily'), FULL, { recursive: true });
  return { workspace: WS, commit: sh('git', ['-c', 'safe.directory=*', 'rev-parse', '--short', 'HEAD'], { cwd: WS }).trim() };
}

function childEnv() {
  const env = { ...process.env };
  // never inherit the live organisation's settings; the workspace's .env supplies them
  for (const k of ['PRINCIPALS_JSON', 'OWNER_PUBLIC_KEY_BASE64', 'API_URL', 'PORT', 'MAX_ORDER_PAISE', 'MAX_EXPOSURE_PAISE', 'MAX_REALISED_LOSS_PAISE',
    'ALERT_WEBHOOK_URL', 'RULE_BOT_ID', 'MODEL_AUTOSTART', 'TA_BOT_ID', 'DEBATE_BULL_BOT', 'DEBATE_BEAR_BOT', 'MODEL_ALLOCATOR_RUN', 'MODEL_ALLOCATOR_BOT', 'RND_SOURCE']) delete env[k];
  return { ...env, REPLAY_CLOCK_FILE: CLOCK, DATABASE_PATH: '.data/replay-paper', NODE_OPTIONS: `--import=${pathToFileURL(join(WS, 'scripts', 'replay-clock.mjs')).href}`,
    PYTHONPATH: join(WS, 'integrations', 'replay'), REPLAY_PRICES: FULL, CYCLE_PYTHON: PY, PYTHONIOENCODING: 'utf-8' };
}

async function setClock(iso) {
  await writeFile(CLOCK, JSON.stringify({ now: iso }));
  await new Promise(r => setTimeout(r, 400)); // the backend re-reads the file every 200 ms
}

async function readEnv() {
  return Object.fromEntries((await readFile(join(WS, '.env'), 'utf8')).split(/\r?\n/).filter(l => l.includes('='))
    .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^'(.*)'$/, '$1')]));
}

function startBackend() {
  const child = spawn(process.execPath, ['--env-file=.env', join('backend', 'dist', 'src', 'main.js')], { cwd: WS, env: childEnv(), windowsHide: true, stdio: 'ignore' });
  return child;
}

async function waitUp(up = true, ms = 60_000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 1000))) {
    const ok = await fetch(API + '/v1/health', { signal: AbortSignal.timeout(2000) }).then(r => r.ok, () => false);
    if (ok === up) return true;
  }
  throw new Error(`replay backend did not ${up ? 'start' : 'stop'}`);
}

async function api(env, role, method, path, body, key) {
  const token = JSON.parse(env.PRINCIPALS_JSON).find(p => p.role === role && !p.botId).token;
  const r = await fetch(API + path, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${path} refused (HTTP ${r.status}): ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

function node(args) {
  return sh(process.execPath, ['--env-file=.env', ...args], { cwd: WS, env: childEnv(), timeout: 3_600_000 });
}

/** The organisation at the start date: a source, money, the rule bot (fitness from the data up to that day, a release,
 *  an evaluation, activation, qualification), exactly as the live organisation was built. */
async function setup(budget) {
  let env = await readEnv();
  await api(env, 'owner', 'POST', '/v1/sources', { id: 'market-yahoo-daily', name: 'Yahoo Finance daily (replay copy)', url: 'https://finance.yahoo.com', approved: true }, 'replay-source');
  const key = await readFile(join(WS, '.local', 'owner-signing-key.pem'), 'utf8');
  const request = { action: 'deposit', payload: { amountPaise: '1000000', bankReference: 'replay-contribution' } };
  const challenge = await api(env, 'owner', 'POST', '/v1/owner/challenges', request);
  await api(env, 'owner', 'POST', '/v1/owner/transactions', { request, proof: { challengeId: challenge.challengeId, signature: sign(null, Buffer.from(challenge.message), key).toString('base64url') } }, 'replay-deposit');
  sh(PY, [join(WS, 'integrations', 'trading-desk', 'regime_study.py')], { cwd: WS, env: childEnv() });
  node([join('scripts', 'activate-rule-bot.mjs'), 'credential', '--yes']);
  return { budget };
}

/** Owner policies for the replay (the same files the live owner would use), applied once the bot is set up. */
async function applyPolicies({ protections, autonomy, charter }) {
  const env = await readEnv(), applied = {};
  const rules = async path => { const p = JSON.parse(await readFile(resolve(ROOT, path), 'utf8')); return p.rules ?? p; };
  if (charter) {
    // the founder charter: both parts, brakes first, exactly as `npm run charter -- set` applies it
    const c = JSON.parse(await readFile(resolve(ROOT, charter), 'utf8'));
    await api(env, 'owner', 'POST', '/v1/protections/policy', { rules: c.protections, reason: `Replay with the charter ${charter}` }, 'replay-charter-protections');
    await api(env, 'owner', 'POST', '/v1/autonomy/policy', { rules: c.autonomy, reason: `Replay with the charter ${charter}` }, 'replay-charter-autonomy');
    return { charter };
  }
  if (protections) { await api(env, 'owner', 'POST', '/v1/protections/policy', { rules: await rules(protections), reason: `Replay with ${protections}` }, 'replay-protections'); applied.protections = protections; }
  if (autonomy) { await api(env, 'owner', 'POST', '/v1/autonomy/policy', { rules: await rules(autonomy), reason: `Replay with ${autonomy}` }, 'replay-autonomy'); applied.autonomy = autonomy; }
  return applied;
}

async function run(from, to, budget, policies = {}) {
  if (!existsSync(WS)) throw new Error('No workspace: run "prepare" first');
  const bars = JSON.parse(await readFile(join(FULL, (await readdir(FULL)).find(n => n.endsWith('-1d.json'))), 'utf8')).bars;
  const days = sessions(bars, from, to);
  if (!days.length) throw new Error(`No sessions between ${from} and ${to} in the price history`);
  const fresh = !existsSync(join(WS, '.data', 'replay-paper'));
  await setClock(indiaTime(days[0], 16, 10));
  node([join('scripts', 'replay-prices.mjs'), FULL, join('.local', 'trading-desk', 'daily')]);
  let backend = startBackend();
  await waitUp();
  const log = [];
  try {
    if (fresh) {
      await setup(budget);
      backend.kill(); await waitUp(false);             // restart so the backend loads the bot's new trader credential
      backend = startBackend(); await waitUp();
      node([join('scripts', 'activate-rule-bot.mjs'), 'apply', '--yes', `--budget-paise=${budget}`]);
      policies.applied = await applyPolicies(policies);
    }
    for (const day of days) {
      await setClock(indiaTime(day, 16, 10));
      let status = 'done', note = '';
      try { node([join('scripts', 'organisation-cycle.mjs')]); } catch (error) { status = 'cycle-failed'; note = String(error.stderr || error.message).slice(-300); }
      log.push({ day, status, ...(note ? { note } : {}) });
      process.stdout.write(`${day} ${status}\n`);
    }
    const env = await readEnv();
    const digest = await api(env, 'owner', 'POST', '/v1/owner/digest', { hours: 24 * 31 });
    const performance = await api(env, 'owner', 'POST', '/v1/paper/performance/history', {}).catch(() => null);
    const result = { from, to, sessions: days.length, failedDays: log.filter(l => l.status !== 'done').length, policies: policies.applied ?? {}, log,
      equityCurves: performance,
      money: digest.money, trading: digest.trading, benchmark: digest.benchmark, protections: digest.protections, limits: digest.limits,
      audit: await api(env, 'owner', 'GET', '/v1/audit/integrity'), finishedAt: new Date().toISOString() };
    await writeFile(REPORT, JSON.stringify(result, null, 2));
    return result;
  } finally {
    backend.kill();
  }
}

async function main() {
  const args = process.argv.slice(2), [command] = args;
  const opt = (name, fallback) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : fallback; };
  if (command === 'prepare') { console.log(JSON.stringify(await prepare(), null, 2)); return; }
  if (command === 'run') {
    const r = await run(opt('from', '2025-04-01'), opt('to', '2025-04-30'), opt('budget-paise', '500000'),
      { protections: opt('protections'), autonomy: opt('autonomy'), charter: opt('charter') });
    console.log(JSON.stringify({ sessions: r.sessions, failedDays: r.failedDays, policies: r.policies, money: r.money, trading: r.trading,
      benchmark: r.benchmark, protections: r.protections, audit: r.audit }, null, 2));
    return;
  }
  if (command === 'report') { console.log(await readFile(REPORT, 'utf8')); return; }
  if (command === 'clean') {
    if (existsSync(WS)) sh('git', ['-c', 'safe.directory=*', 'worktree', 'remove', '--force', WS], { cwd: ROOT });
    await rm(HOME, { recursive: true, force: true });
    console.log('replay workspace removed');
    return;
  }
  throw new Error('Usage: replay-org.mjs prepare | run --from YYYY-MM-DD --to YYYY-MM-DD | report | clean');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
