// Go / no-go before a live paper-trading day (OPS-02). Read-only: it asks the backend and reads local files, and changes
// nothing. Each check is GO, WARN (works, but something is degraded or not set up) or NO-GO (the day should not start),
// with what to do about it. The report is also written to .local/readiness/<day>.json.
//   node --env-file=.env scripts/readiness.mjs          exit code 1 on NO-GO
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const UNIVERSE = ['AXISBANK', 'HDFCBANK', 'ICICIBANK', 'INFY', 'ITC', 'NTPC', 'RELIANCE', 'SBIN'];
const RULE_MODEL = 'rules:top3-momentum-6m';
const LEARNING_STEPS = ['claims-and-fact-check', 'learning-workflows', 'chain-links', 'model-allocator-decide', 'debate'];
const DAY = 86_400_000;

/** The latest NSE session whose daily bar should be settled by `now` (15:30 IST close + 30 min); weekends skipped, and
 *  exchange holidays too when the owner's calendar lists them. */
export function expectedSession(now, holidays = new Set()) {
  for (let d = new Date(now); ; d = new Date(d.getTime() - DAY)) {
    const day = d.toISOString().slice(0, 10), weekday = d.getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !holidays.has(day) && Date.parse(day + 'T10:30:00Z') <= now) return day;
  }
}

/** The owner's NSE trading-holiday calendar (.local/nse-holidays.json), copied from the exchange's official circular:
 *  {"source": "<circular or URL>", "years": [2026], "days": ["YYYY-MM-DD", ...]}. Never guessed: absent means unknown. */
export function parseHolidays(text) {
  let value;
  try { value = JSON.parse(text); } catch { return { error: 'not valid JSON' }; }
  const days = value?.days, years = value?.years;
  if (typeof value?.source !== 'string' || !value.source.trim()) return { error: 'needs "source": the exchange circular it was copied from' };
  if (!Array.isArray(years) || !years.length || !years.every(y => Number.isInteger(y) && y >= 2000 && y <= 2100)) return { error: 'needs "years" it covers' };
  if (!Array.isArray(days)) return { error: 'needs "days"' };
  for (const day of days) {
    const at = Date.parse(String(day) + 'T00:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day)) || Number.isNaN(at) || new Date(at).toISOString().slice(0, 10) !== day) return { error: `"${day}" is not a date` };
    if (!years.includes(Number(day.slice(0, 4)))) return { error: `${day} is outside the years it says it covers` };
  }
  return { source: value.source, years: new Set(years), days: new Set(days) };
}

const check = (id, status, detail, action) => ({ id, status, detail, ...(action ? { action } : {}) });

/** Pure: facts in, checks out. */
export function assess(f, now) {
  const out = [];
  out.push(f.health ? check('backend', 'GO', 'API answers in paper mode') : check('backend', 'NO-GO', 'API not reachable', 'Start it: npm.cmd start'));
  if (!f.health) return out;
  out.push(f.credentials.missing.length ? check('credentials', 'NO-GO', `missing: ${f.credentials.missing.join(', ')}`, 'Fix PRINCIPALS_JSON in .env')
    : check('credentials', 'GO', 'owner, researcher and evaluator configured'));
  out.push(f.audit?.valid === true ? check('audit-chain', 'GO', 'hash chain intact')
    : check('audit-chain', 'NO-GO', 'audit chain broken or unreadable', 'Investigate before trading; restore the last good backup if needed'));
  // without the digest, the halt and alert state is unknown: never report GO on missing facts
  if (!f.digest) out.push(check('risk-halt', 'NO-GO', 'could not read the owner digest, so the halt and alert state is unknown', 'Check the evaluator credential and the backend log'));
  else out.push(f.digest.halted ? check('risk-halt', 'NO-GO', 'new risk is halted', 'Owner decides whether to resume') : check('risk-halt', 'GO', 'not halted'));
  const alerts = f.digest?.alerts ?? {};
  out.push(alerts.critical ? check('alerts', 'NO-GO', `${alerts.critical} critical alert(s) open`, 'Resolve or acknowledge them')
    : alerts.warning ? check('alerts', 'WARN', `${alerts.warning} warning alert(s) open`, 'Read today\'s digest') : check('alerts', 'GO', 'none open'));

  // the calendar is optional: without it, holidays are simply unknown (as before); a broken one is never trusted
  const cal = f.holidays ?? null, known = cal && !cal.error ? cal : null;
  const today = new Date(now + 330 * 60_000).toISOString().slice(0, 10);
  if (cal?.error) out.push(check('calendar', 'WARN', `.local/nse-holidays.json ignored: ${cal.error}`, 'Fix it from the NSE holiday circular'));
  else if (known && !known.years.has(Number(today.slice(0, 4)))) out.push(check('calendar', 'WARN', `the holiday calendar does not cover ${today.slice(0, 4)}`,
    'Add this year\'s NSE trading holidays to .local/nse-holidays.json'));
  else if (known?.days.has(today)) out.push(check('calendar', 'GO', `today (${today}) is an NSE trading holiday: no session, no cycle needed`));
  const expected = expectedSession(now, known?.days);
  const stale = UNIVERSE.filter(s => !f.prices[s] || f.prices[s].date < expected);
  const old = UNIVERSE.filter(s => !f.prices[s] || now - Date.parse(f.prices[s].date + 'T10:00:00Z') > 5 * DAY);
  out.push(old.length ? check('market-data', 'NO-GO', `older than 5 days or missing: ${old.join(', ')}`, 'Run the cycle (market-data step) or daily.py fetch --refresh')
    : stale.length ? check('market-data', 'WARN', `not yet at ${expected}: ${stale.join(', ')}${known ? '' : ' (fine on an exchange holiday)'}`, 'Run the cycle after 16:00 IST')
      : check('market-data', 'GO', `all ${UNIVERSE.length} shares at ${expected}`));

  const costBps = BigInt(f.limits.feeBps + f.limits.slippageBps);
  const tooDear = UNIVERSE.filter(s => f.prices[s] && BigInt(f.prices[s].closePaise) * (10000n + costBps) / 10000n > BigInt(f.limits.maxOrderPaise));
  out.push(tooDear.length ? check('order-limit', 'WARN', `MAX_ORDER_PAISE ${f.limits.maxOrderPaise} is below one share of ${tooDear.join(', ')}; those proposals will be rejected`,
    'Owner decision: raise MAX_ORDER_PAISE (and MAX_EXPOSURE_PAISE) in .env, then restart') : check('order-limit', 'GO', 'one share of every tracked share fits an order'));

  const rb = f.ruleBot;
  if (!rb.id) out.push(check('rule-bot', 'WARN', 'no rule bot configured: without the model, no bot proposes', 'node --env-file=.env scripts/activate-rule-bot.mjs plan'));
  else if (!rb.credential) out.push(check('rule-bot', 'NO-GO', `RULE_BOT_ID=${rb.id} has no trader credential bound to it`, 'activate-rule-bot.mjs credential --yes, then restart'));
  else if (rb.state !== 'paper') out.push(check('rule-bot', 'NO-GO', `${rb.id} is ${rb.state ?? 'not created'}, not qualified for paper`, 'activate-rule-bot.mjs apply --yes'));
  else if (rb.activeModel !== RULE_MODEL) out.push(check('rule-bot', 'NO-GO', `${rb.id} has no active release of ${RULE_MODEL}`, 'activate-rule-bot.mjs apply --yes'));
  // RELEASE-01: the cycle will refuse to run code that is not the authorised release; say so before the day starts
  else if (rb.gate) out.push(check('rule-bot', 'WARN', `${rb.id}: ${rb.gate}`, 'npm.cmd run rulebot -- apply --yes (registers, evaluates and activates a release for the current code)'));
  else out.push(check('rule-bot', 'GO', `${rb.id} qualified, release active, credential bound`));

  const failed = f.lastCycle?.failed ?? [], degraded = f.lastCycle?.degraded ?? [];
  out.push(!f.lastCycle ? check('last-cycle', 'WARN', 'no cycle has run yet', 'npm.cmd run cycle')
    : failed.length ? check('last-cycle', 'WARN', `${f.lastCycle.day}: failed ${failed.join(', ')}`, 'Read .local/cycles/' + f.lastCycle.day + '.json and rerun: npm.cmd run cycle')
      : check('last-cycle', 'GO', `${f.lastCycle.day}: no failed steps`));
  // learning that silently did not happen is still not happening: say so (no model, or its setup missing)
  const unlearned = (f.lastCycle?.skipped ?? []).filter(s => LEARNING_STEPS.includes(s.id));
  if (unlearned.length) out.push(check('learning', 'WARN', `no knowledge was learned in the last cycle: ${unlearned.map(s => `${s.id} skipped (${s.reason})`).join('; ')}`,
    'Run the cycle with the local model (npm run cycle -- --with-model) once its setup exists; see docs/operations-cycle.md'));
  // a degraded step finished but needs a person: e.g. data kept back by the steward, or a split to record
  for (const d of degraded) out.push(check('needs-owner', 'WARN', `${d.id}: ${d.note}`, d.note.includes('corporate-actions')
    ? 'Check the exchange notice, then record it: POST /v1/corporate-actions' : 'Read .local/cycles/' + f.lastCycle.day + '.json'));
  out.push(f.backupAt === null ? check('backup', 'WARN', 'no backup yet', 'Stop the API, npm.cmd run backup -- create, restart')
    : now - f.backupAt > 2 * DAY ? check('backup', 'WARN', `last backup ${new Date(f.backupAt).toISOString().slice(0, 16)}Z (over 2 days)`, 'Stop the API, npm.cmd run backup -- create, restart')
      : check('backup', 'GO', `last backup ${new Date(f.backupAt).toISOString().slice(0, 16)}Z`));
  return out;
}

export const verdict = checks => checks.some(c => c.status === 'NO-GO') ? 'NO-GO' : checks.some(c => c.status === 'WARN') ? 'GO WITH WARNINGS' : 'GO';

/** Collects the facts: backend answers plus local files. Network failures become missing facts, never crashes. */
export async function gather(env, { fetchImpl = fetch, root = ROOT, gate = null } = {}) {
  const base = (env.API_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
  if (!/^(https:\/\/[^/@?#]+|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?)$/.test(base)) throw new Error('Invalid backend API origin');
  const principals = JSON.parse(env.PRINCIPALS_JSON || '[]');
  const token = role => principals.find(p => p.role === role && !p.botId)?.token;
  const ask = async (role, method, path, body) => {
    try {
      const r = await fetchImpl(base + path, { method, redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { 'Content-Type': 'application/json', ...(role ? { Authorization: 'Bearer ' + token(role) } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  };
  const ruleId = env.RULE_BOT_ID || null;
  const health = (await ask(null, 'GET', '/v1/health'))?.mode === 'paper';
  const [audit, digest, bots, view] = health ? await Promise.all([ask('owner', 'GET', '/v1/audit/integrity'), ask('evaluator', 'POST', '/v1/owner/digest', {}),
    ask('owner', 'GET', '/v1/bots'), ruleId ? ask('owner', 'POST', '/v1/releases/view', { botId: ruleId }) : null]) : [];
  const active = view?.releases?.find(r => r.id === view.active);
  // the same release check the cycle runs before the rule bot (its identity from its own code): null when allowed
  const gateNote = health && ruleId && active ? await (gate ?? (async botId => {
    const { releaseCheck } = await import('./organisation-cycle.mjs');
    const py = env.CYCLE_PYTHON || join(root, '.local', 'replay-venv', ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']));
    return releaseCheck({ botId, cmd: py, args: [join(root, 'integrations', 'trading-desk', 'rule_bot.py'), '--describe'] }, { env, fetchImpl });
  }))(ruleId) : null;

  const prices = {};
  for (const s of UNIVERSE) {
    const path = join(root, '.local', 'trading-desk', 'daily', `${s}.NS-1d.json`);
    if (!existsSync(path)) continue;
    const bar = JSON.parse(await readFile(path, 'utf8')).bars.at(-1);
    if (bar) prices[s] = { date: bar.date, closePaise: String(bar.closePaise) };
  }
  const cycles = join(root, '.local', 'cycles');
  const days = existsSync(cycles) ? (await readdir(cycles)).filter(n => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort() : [];
  let lastCycle = null;
  if (days.length) {
    const journal = JSON.parse(await readFile(join(cycles, days.at(-1)), 'utf8'));
    const steps = Object.entries(journal.steps ?? {});
    lastCycle = { day: days.at(-1).slice(0, 10), failed: steps.filter(([, s]) => s.status === 'failed').map(([id]) => id),
      degraded: steps.filter(([, s]) => s.status === 'degraded').map(([id, s]) => ({ id, note: String(s.reason ?? 'finished with a caveat') })),
      skipped: steps.filter(([, s]) => s.status === 'skipped').map(([id, s]) => ({ id, reason: String(s.reason ?? 'skipped') })) };
  }
  const calendar = join(root, '.local', 'nse-holidays.json');
  const holidays = existsSync(calendar) ? parseHolidays(await readFile(calendar, 'utf8')) : null;
  const backups = join(root, '.local', 'backups');
  let backupAt = null;
  if (existsSync(backups)) for (const n of await readdir(backups)) {
    if (n.startsWith('backup-') && existsSync(join(backups, n, 'manifest.json'))) backupAt = Math.max(backupAt ?? 0, (await stat(join(backups, n, 'manifest.json'))).mtimeMs);
  }
  return {
    health, audit, digest, prices, lastCycle, backupAt, holidays,
    credentials: { missing: ['owner', 'researcher', 'evaluator'].filter(r => !token(r)) },
    limits: { maxOrderPaise: env.MAX_ORDER_PAISE || '100000', feeBps: Number(env.PAPER_FEE_BPS || 10), slippageBps: Number(env.PAPER_SLIPPAGE_BPS || 5) },
    ruleBot: { id: ruleId, credential: !!ruleId && principals.some(p => p.role === 'trader' && p.botId === ruleId && p.token),
      state: Array.isArray(bots) ? bots.find(b => b.id === ruleId)?.state ?? null : null, activeModel: active?.model ?? null, gate: gateNote },
  };
}

export async function run(env = process.env, { fetchImpl = fetch, root = ROOT, now = Date.now(), gate = null } = {}) {
  const checks = assess(await gather(env, { fetchImpl, root, gate }), now);
  const report = { at: new Date(now).toISOString(), verdict: verdict(checks), checks };
  await mkdir(join(root, '.local', 'readiness'), { recursive: true });
  await writeFile(join(root, '.local', 'readiness', report.at.slice(0, 10) + '.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().then(report => {
    for (const c of report.checks) console.log(`${c.status.padEnd(6)} ${c.id.padEnd(12)} ${c.detail}${c.action ? `\n${' '.repeat(20)}-> ${c.action}` : ''}`);
    console.log(`\n${report.verdict}`);
    process.exitCode = report.verdict === 'NO-GO' ? 1 : 0;
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
