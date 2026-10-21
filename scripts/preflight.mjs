// Saturday preflight (OPS-05): everything the organisation needs before it is switched on to run by itself, checked in
// one read-only pass while the backend is still down, each gap with what to do. It never prints a setting's value, a
// token or a key: only which names are missing.
//   npm run preflight
import { existsSync, statSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedSession, parseHolidays, UNIVERSE } from './readiness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 86_400_000;
const check = (id, status, detail, action = null) => ({ id, status, detail, ...(action ? { action } : {}) });

/** Pure: facts in, the checklist out. status: OK (ready), TODO (needed before switching on), OPTIONAL (recommended). */
export function assess(f, now = Date.now()) {
  const out = [];
  const s = f.settings;
  const roles = s.roles ?? [];
  const missingRoles = ['owner', 'researcher', 'evaluator'].filter(r => !roles.includes(r));
  out.push(!s.present ? check('settings', 'TODO', 'no .env file', 'npm run dev:setup (creates credentials and the owner key)')
    : missingRoles.length || !s.has.OWNER_PUBLIC_KEY_BASE64 ? check('settings', 'TODO', `missing: ${[...missingRoles.map(r => r + ' credential'), ...(s.has.OWNER_PUBLIC_KEY_BASE64 ? [] : ['OWNER_PUBLIC_KEY_BASE64'])].join(', ')}`,
      'Run npm run dev:setup on a fresh checkout, or restore .env from .local/env-backups')
      : check('settings', 'OK', 'owner, researcher and evaluator credentials and the owner key are set'));
  out.push(!s.has.RULE_BOT_ID ? check('rule-bot', 'TODO', 'RULE_BOT_ID is not set: the cycle will not propose anything', 'npm run rulebot -- plan, then credential --yes and apply --yes')
    : !s.ruleBotCredential ? check('rule-bot', 'TODO', 'the rule bot has no trader credential bound to it', 'npm run rulebot -- credential --yes')
      : check('rule-bot', 'OK', 'rule bot named and its credential bound'));
  out.push(f.backendUp ? check('backend', 'TODO', 'the backend is running: the backup below needs it stopped', 'Stop it (Ctrl+C in its terminal), then take the backup')
    : check('backend', 'OK', 'stopped, ready for the backup'));
  const newest = f.newestMigrationAt, backup = f.backupAt;
  out.push(backup === null ? check('backup', 'TODO', 'no backup yet', 'npm run backup -- create (with the backend stopped)')
    : newest !== null && backup < newest ? check('backup', 'TODO', `the last backup (${new Date(backup).toISOString().slice(0, 10)}) is older than the newest migration (${f.newestMigration}), which applies on the next start`,
      'npm run backup -- create before npm start')
      : now - backup > 2 * DAY ? check('backup', 'TODO', `the last backup is ${Math.floor((now - backup) / DAY)} days old`, 'npm run backup -- create before npm start')
        : check('backup', 'OK', `last backup ${new Date(backup).toISOString().slice(0, 16)}Z`));
  out.push(!f.venv ? check('python', 'TODO', 'the research environment (.local/replay-venv) is missing', 'See docs/live-testing.md: create .local/replay-venv')
    : check('python', 'OK', 'research environment present'));
  const stale = f.lastBar && f.lastBar < expectedSession(now, f.holidayDays ?? new Set());
  out.push(!f.lastBar ? check('market-data', 'TODO', 'no daily price files', 'The cycle fetches them (market-data step)')
    : check('market-data', 'OK', `prices to ${f.lastBar}${stale ? '; the first cycle refreshes them' : ''}`));
  // the model makes eight agent roles work; without it the organisation runs model-free
  const m = f.model;
  out.push(!s.has.MODEL_AUTOSTART ? check('model', 'OPTIONAL', 'MODEL_AUTOSTART is not set: the cycle runs without the model (8 agent roles idle)', 'Add MODEL_AUTOSTART=qwen3.5-4b-q4km to .env (after: npm run model:local -- install qwen3.5-4b-q4km)')
    : !m.known ? check('model', 'TODO', `MODEL_AUTOSTART names a model the lock file does not know`, 'Use a key from config/local-model.lock.json, e.g. qwen3.5-4b-q4km')
      : !m.weights || !m.runtime ? check('model', 'TODO', `${m.weights ? '' : 'the model weights are'}${!m.weights && !m.runtime ? ' and ' : ''}${m.runtime ? '' : 'the llama.cpp runtime is'} not downloaded`,
        'npm run model:local -- install ' + s.modelKey + ' (a large download: ask first on the office laptop)')
        : !s.has.HERMES_MODEL_BASE_URL ? check('model', 'TODO', 'HERMES_MODEL_BASE_URL is not set, so the supervisor cannot see the model', 'Set it to http://127.0.0.1:8080/v1 in .env')
          : check('model', 'OK', 'model and runtime present; the supervisor starts it for the cycle'));
  if (s.has.TA_BOT_ID && !f.taVenv) out.push(check('tradingagents', 'TODO', 'TA_BOT_ID is set but its environment (.local/tradingagents-venv) is missing', 'See integrations/tradingagents/README.md'));
  out.push(f.policyValid ? check('standing-approvals', 'OPTIONAL', 'the starter policy is ready to apply (protective only, moves no money)',
    'After npm start: npm run autonomy -- set docs/policies/autonomy-starter.json --reason "Starter: protect, repair, roll back"')
    : check('standing-approvals', 'TODO', 'docs/policies/autonomy-starter.json is missing or invalid', 'Restore it from git'));
  out.push(!f.holidays ? check('holidays', 'OPTIONAL', 'no NSE holiday file: holidays are treated as missing data', 'Copy this year\'s dates from NSE\'s circular into .local/nse-holidays.json')
    : f.holidays.error ? check('holidays', 'TODO', 'the holiday file is not usable: ' + f.holidays.error, 'Fix .local/nse-holidays.json')
      : ![...f.holidays.years].includes(new Date(now + 330 * 60_000).getUTCFullYear()) ? check('holidays', 'TODO', `the holiday file covers ${[...f.holidays.years].join(', ')}, not this year`, 'Add this year\'s dates from NSE\'s circular')
        : check('holidays', 'OK', `holiday file covers ${[...f.holidays.years].join(', ')}`));
  out.push(!s.has.ALERT_WEBHOOK_URL ? check('alerts', 'OPTIONAL', 'alerts go only to the local outbox', 'Set ALERT_WEBHOOK_URL in .env (an ntfy topic works)')
    : check('alerts', 'OK', 'alert channel set'));
  out.push(f.supervisor === 'alive' ? check('supervisor', 'OK', 'running')
    : check('supervisor', 'OPTIONAL', f.supervisor === 'stale' ? 'it ran before but is not running now' : 'not started yet', 'npm run supervisor, or once: pwsh -File scripts\\install-supervisor-task.ps1'));
  out.push(f.worldFeeds > 3 ? check('world-news', 'OK', `${f.worldFeeds} feeds enabled`)
    : check('world-news', 'OPTIONAL', `${f.worldFeeds} feeds enabled (India only)`, 'After npm start: npm run world -- probe --all, then enable <ids> --yes'));
  return out;
}

export const summary = checks => {
  const todo = checks.filter(c => c.status === 'TODO').length, optional = checks.filter(c => c.status === 'OPTIONAL').length;
  return todo ? `NOT READY: ${todo} thing(s) to do first${optional ? `, ${optional} recommended` : ''}` : `READY${optional ? ` (${optional} recommended)` : ''}`;
};

/** Facts from local files and the environment (names only); a backend health ping on loopback. */
export async function gather(env = process.env, { root = ROOT, fetchImpl = fetch, now = Date.now() } = {}) {
  let principals = [];
  try { principals = JSON.parse(env.PRINCIPALS_JSON || '[]'); } catch { /* treated as missing */ }
  const names = ['OWNER_PUBLIC_KEY_BASE64', 'RULE_BOT_ID', 'MODEL_AUTOSTART', 'HERMES_MODEL_BASE_URL', 'ALERT_WEBHOOK_URL', 'TA_BOT_ID'];
  const settings = { present: existsSync(join(root, '.env')) || !!env.PRINCIPALS_JSON, roles: [...new Set(principals.filter(p => p.token).map(p => p.role))],
    has: Object.fromEntries(names.map(n => [n, !!env[n]])), modelKey: env.MODEL_AUTOSTART || null,
    ruleBotCredential: !!env.RULE_BOT_ID && principals.some(p => p.role === 'trader' && p.botId === env.RULE_BOT_ID && p.token) };
  const api = (env.API_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
  const backendUp = await fetchImpl(api + '/v1/health', { signal: AbortSignal.timeout(2000) }).then(r => r.ok, () => false);
  const migrations = existsSync(join(root, 'db', 'migrations')) ? (await readdir(join(root, 'db', 'migrations'))).filter(n => n.endsWith('.sql')).sort() : [];
  const newestMigration = migrations.at(-1) ?? null;
  let backupAt = null;
  const backups = join(root, '.local', 'backups');
  if (existsSync(backups)) for (const n of await readdir(backups))
    if (n.startsWith('backup-') && existsSync(join(backups, n, 'manifest.json'))) backupAt = Math.max(backupAt ?? 0, statSync(join(backups, n, 'manifest.json')).mtimeMs);
  const venvPy = name => join(root, '.local', name, ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']));
  let lastBar = null;
  for (const s of UNIVERSE) {
    const path = join(root, '.local', 'trading-desk', 'daily', `${s}.NS-1d.json`);
    if (existsSync(path)) { const d = JSON.parse(await readFile(path, 'utf8')).bars.at(-1)?.date; if (d && (!lastBar || d < lastBar)) lastBar = d; }
  }
  let model = { known: false, weights: false, runtime: false };
  try {
    const lock = JSON.parse(await readFile(join(root, 'config', 'local-model.lock.json'), 'utf8')), m = lock.models[settings.modelKey ?? ''];
    const weights = m && join(root, '.local', 'models', m.file);
    model = { known: !!m, weights: !!m && existsSync(weights) && statSync(weights).size === m.bytes,
      runtime: existsSync(join(root, '.local', 'models', 'llama.cpp-' + lock.runtime.release)) };
  } catch { /* no lock file: unknown model */ }
  let policyValid = false;
  try { const p = JSON.parse(await readFile(join(root, 'docs', 'policies', 'autonomy-starter.json'), 'utf8')); policyValid = p.raiseBudget === null && typeof p.suspendOnRecommendation === 'boolean'; } catch { /* invalid */ }
  const calendar = join(root, '.local', 'nse-holidays.json');
  const holidays = existsSync(calendar) ? parseHolidays(await readFile(calendar, 'utf8')) : null;
  let supervisor = 'never';
  try { supervisor = now - Date.parse(JSON.parse(await readFile(join(root, '.local', 'supervisor', 'heartbeat.json'), 'utf8')).at) <= 5 * 60_000 ? 'alive' : 'stale'; } catch { /* never */ }
  const local = join(root, '.local');
  let worldFeeds = 0;
  for (const n of existsSync(local) ? await readdir(local) : []) {
    if (!/^feed-[a-z0-9-]+\.json$/.test(n)) continue;
    try { if (JSON.parse(await readFile(join(local, n), 'utf8')).enabled === true) worldFeeds++; } catch { /* not a feed */ }
  }
  return { settings, backendUp, newestMigration, newestMigrationAt: newestMigration ? statSync(join(root, 'db', 'migrations', newestMigration)).mtimeMs : null, backupAt,
    venv: existsSync(venvPy('replay-venv')), taVenv: existsSync(venvPy('tradingagents-venv')), lastBar, model, policyValid,
    holidays: holidays && !holidays.error ? { years: holidays.years ?? [], days: holidays.days } : holidays, holidayDays: holidays?.days, supervisor, worldFeeds };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  gather().then(f => {
    const checks = assess(f);
    for (const c of checks) console.log(`${c.status.padEnd(8)} ${c.id.padEnd(19)} ${c.detail}${c.action ? `\n${' '.repeat(29)}-> ${c.action}` : ''}`);
    console.log('\n' + summary(checks));
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
