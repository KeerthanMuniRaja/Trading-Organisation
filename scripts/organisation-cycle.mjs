// One finite organisation cycle (AUTO-01): data -> knowledge -> chains -> forward tests -> P&L mark -> alerts.
// Each step is a separate child process with a time limit; a daily journal (.local/cycles/<day>.json) makes reruns
// resume: completed steps are skipped, failed or skipped ones run again. Only a failed backend health check stops the
// cycle. Model-backed steps run only with --with-model (and need the local model server); everything else needs no
// model. Nothing here trades, funds, or changes limits: those stay with reviews, owner decisions and paper trading.
//   node --env-file=.env scripts/organisation-cycle.mjs [--with-model] [--force]
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// the research environment's Python: Scripts\python.exe on Windows, bin/python on Linux (WSL, a VM, the container);
// CYCLE_PYTHON overrides it for any other layout
const PY = process.env.CYCLE_PYTHON || join(ROOT, '.local', 'replay-venv', ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']));
const NODE = process.execPath;

export async function planSteps({ withModel = false, root = ROOT } = {}) {
  const candidates = existsSync(join(root, '.local')) ? (await readdir(join(root, '.local'))).filter(n => /^feed-[a-z0-9-]+\.json$/.test(n)).sort() : [];
  const feeds = [];
  for (const name of candidates) { // only configurations the owner explicitly enabled; fixtures and drafts are ignored
    try { if (JSON.parse(await readFile(join(root, '.local', name), 'utf8')).enabled === true) feeds.push(name); } catch { /* not a feed config */ }
  }
  const desk = p => join(root, 'integrations', 'trading-desk', p);
  const steps = [
    { id: 'backend-health', critical: true, kind: 'http', path: '/v1/health' },
    { id: 'market-data', cmd: PY, args: [desk('daily.py'), 'fetch', '--refresh'], timeoutMs: 600_000, retries: 2, verify: verifyMarketData },
    ...feeds.map(f => ({ id: 'news-' + f.slice(5, -5), cmd: NODE, args: ['--env-file=.env', join(root, 'scripts', 'run-feed-cycle.mjs'), 'run',
      join('.local', f), join('.local', 'feeds', f.slice(5, -5))], timeoutMs: 120_000, okCodes: [0], retries: 2, verify: verifyFeed })),
    // KNOW-02: fixed backend rules set aside news about nothing the organisation tracks, before anyone reviews it
    { id: 'news-triage', kind: 'http', method: 'POST', path: '/v1/evidence/triage', role: 'evaluator', freshKey: true },
    withModel
      ? { id: 'claims-and-fact-check', cmd: PY, args: [join(root, 'integrations', 'claims', 'autolearn.py'), 'run', '--config', join('.local', 'claims', 'autolearn.json'),
          '--cycles', '1'], timeoutMs: 3_600_000, requires: join(root, '.local', 'claims', 'autolearn.json') }
      : { id: 'claims-and-fact-check', skip: 'model steps not enabled (--with-model)' },
    // AUTO-02: every open learning workflow advances one stage for the role it waits on (the model writes the lessons)
    withModel
      ? { id: 'learning-workflows', cmd: NODE, args: ['--env-file=.env', join(root, 'scripts', 'learning-cycle.mjs')], timeoutMs: 3_600_000 }
      : { id: 'learning-workflows', skip: 'model steps not enabled (--with-model)' },
    { id: 'chain-links', cmd: PY, args: [desk('chains.py'), 'expand', '--headlines', join('.local', 'claims', 'auto', 'verified-headlines.json')],
      timeoutMs: 120_000, requires: join(root, '.local', 'claims', 'auto', 'verified-headlines.json') },
    { id: 'forward-daily-rules', cmd: PY, args: [desk('daily.py'), 'forward', '--name', 'forward-from-2026-10-09'], timeoutMs: 300_000 },
    { id: 'forward-portfolio', cmd: PY, args: [desk('portfolio_daily.py'), 'forward', '--name', 'portfolio-forward-from-2026-10-09'], timeoutMs: 300_000 },
    // ORG-03: the academy and lifecycle run every day. Each backend cycle answers 'disabled' until the owner enables its
    // policy, so these cost nothing until then: exams and remediation for students, lifecycle (births from blueprints,
    // school to college, reputation, retirement requests), research dispatch, registered experiments, reviewed memory.
    ...[['academy-exams', '/v1/skills/cycles', 'evaluator'], ['academy-remediation', '/v1/skills/remediation/cycles', 'evaluator'],
      ['lifecycle', '/v1/lifecycle/cycles', 'evaluator'], ['research-dispatch', '/v1/dispatch/cycles', 'evaluator'],
      ['experiment-reviews', '/v1/development/experiments/cycles', 'evaluator'], ['memory-research', '/v1/learning/cycles', 'researcher'],
      ['memory-review', '/v1/learning/cycles', 'evaluator']].map(([id, path, role]) => ({ id, kind: 'http', method: 'POST', path, role })),
    // RND-01: R&D screens its fixed catalogue of strategy ideas every day (no model); it turns a robust one into verified
    // evidence and a birth proposal for the owner's agenda only once the owner named an approved research source
    // RND-03: with the model on, R&D first invents new ideas (specifications only, at most 3 a month, each raising the bar)
    { id: 'rnd-scout', cmd: PY, args: [desk('rnd_scout.py'), ...(withModel ? ['--invent', 'model'] : []), ...(process.env.RND_SOURCE
      ? ['--propose', '--source', process.env.RND_SOURCE, '--department', process.env.RND_DEPARTMENT || 'desk'] : [])], timeoutMs: 300_000 },
    // the model-free rule bot proposes once a month, before the end-of-day trader reviews; it runs only once the owner
    // has created and qualified it and named it here (RULE_BOT_ID), with a trader credential bound to it
    // AUTO-05 self-repair: a code fix under the same rule is prepared as a release by the agents, and the standing
    // approvals (if the owner allows trials) start it as a canary right away, so the rule bot is not blocked by it
    ...(process.env.RULE_BOT_ID ? [
      { id: 'release-renewal', cmd: NODE, args: ['--env-file=.env', join(root, 'scripts', 'release-renewal.mjs')], timeoutMs: 120_000 },
      { id: 'release-trial', kind: 'http', method: 'POST', path: '/v1/autonomy/apply', role: 'evaluator' },
    ] : []),
    // RELEASE-01: it runs only while its exact code is the authorised release (a changed file needs a new release first)
    process.env.RULE_BOT_ID
      ? { id: 'rule-bot', cmd: PY, args: [desk('rule_bot.py'), '--bot', process.env.RULE_BOT_ID, '--source', process.env.PRICE_EVIDENCE_SOURCE || 'market-yahoo-daily'], timeoutMs: 300_000,
          releaseGate: { botId: process.env.RULE_BOT_ID, cmd: PY, args: [desk('rule_bot.py'), '--describe'] } }
      : { id: 'rule-bot', skip: 'no rule bot configured (RULE_BOT_ID)' },
    // RND-02: bots born from R&D are onboarded (release, screening fitness, evaluation) and, once qualified, run their
    // rule monthly; each checks its own release before proposing. With no R&D bots this only lists the bots.
    { id: 'rnd-bots', cmd: PY, args: [desk('rnd_bot.py'), 'all', '--source', process.env.PRICE_EVIDENCE_SOURCE || 'market-yahoo-daily'], timeoutMs: 300_000 },
    // the model allocator: the model decides its month in the pre-registered forward test (model needed), then the
    // decision becomes proposals with verified facts (no model); both only once the owner names the run and its bot
    ...(process.env.MODEL_ALLOCATOR_RUN && process.env.MODEL_ALLOCATOR_BOT ? [
      withModel ? { id: 'model-allocator-decide', cmd: PY, args: [desk('ai_allocator.py'), 'forward', '--name', process.env.MODEL_ALLOCATOR_RUN, '--max-calls', '2'], timeoutMs: 1_200_000,
          computeGate: { botId: process.env.MODEL_ALLOCATOR_BOT } }
        : { id: 'model-allocator-decide', skip: 'model steps not enabled (--with-model)' },
      { id: 'model-allocator-propose', cmd: PY, args: [desk('model_allocator.py'), '--bot', process.env.MODEL_ALLOCATOR_BOT, '--run', process.env.MODEL_ALLOCATOR_RUN,
        '--source', process.env.PRICE_EVIDENCE_SOURCE || 'market-yahoo-daily'], timeoutMs: 300_000 },
    ] : [{ id: 'model-allocator', skip: 'no model allocator configured (MODEL_ALLOCATOR_RUN, MODEL_ALLOCATOR_BOT)' }]),
    { id: 'eod-trading', cmd: PY, args: [desk('eod_trader.py'), '--source', process.env.PRICE_EVIDENCE_SOURCE || 'market-yahoo-daily'], timeoutMs: 300_000 },
    { id: 'score-signals', cmd: PY, args: [desk('signal_scorer.py'), '--source', process.env.PRICE_EVIDENCE_SOURCE || 'market-yahoo-daily'], timeoutMs: 300_000 },
    { id: 'live-fitness', cmd: NODE, args: ['--env-file=.env', join(root, 'scripts', 'live-fitness.mjs')], timeoutMs: 120_000 },
    { id: 'paper-snapshot', kind: 'http', method: 'POST', path: '/v1/paper/performance/snapshots', role: 'evaluator' },
    // ORG-02: the daily management review of every working bot; it only recommends, the owner decides (npm run agenda)
    { id: 'management-review', kind: 'http', method: 'POST', path: '/v1/management/reviews', role: 'evaluator' },
    // AUTO-03: the agents carry out what the owner's standing approvals cover (nothing without a policy)
    { id: 'autonomy', kind: 'http', method: 'POST', path: '/v1/autonomy/apply', role: 'evaluator' },
    { id: 'alerts', cmd: NODE, args: ['--env-file=.env', join(root, 'scripts', 'deliver-alerts.mjs')], timeoutMs: 120_000 },
    { id: 'owner-digest', cmd: NODE, args: ['--env-file=.env', join(root, 'scripts', 'daily-digest.mjs')], timeoutMs: 120_000 },
  ];
  return steps;
}

/** The last JSON value printed by a step (an object or an array), or null. */
export function lastJson(output) {
  for (const opener of ['[', '{']) {
    for (let i = output.lastIndexOf(opener); i >= 0; i = output.lastIndexOf(opener, i - 1)) {
      try { return JSON.parse(output.slice(i)); } catch { /* keep looking further back */ }
    }
  }
  return null;
}

/** Postcondition: every share was refreshed or deliberately kept; a steward rejection is 'degraded', not silent. */
export function verifyMarketData(output) {
  const results = lastJson(output);
  if (!Array.isArray(results)) return { status: 'failed', note: 'no refresh report' };
  const held = results.filter(r => r.state === 'kept-previous' || r.state === 'rejected' || r.state === 'skipped').map(r => r.symbol);
  // CORP-01: an accepted refresh that rescaled the whole past looks like a split or bonus the owner must record
  const actions = results.flatMap(r => (r.warnings ?? []).filter(w => w.check === 'corporate-action-suspected')
    .map(w => `${r.symbol.replace(/\.NS$/, '')} x${w.factor} from ${w.likelyExDate ?? 'unknown date'}`));
  // a refresh kept back for a large move needs the owner: check the news, and if real, confirm it once
  const moves = results.flatMap(r => (r.issues ?? []).filter(i => i.check === 'extreme-move')
    .map(i => `${r.symbol} ${i.changePct}% on ${i.date} (if real: daily.py accept-move --symbol ${r.symbol} --date ${i.date})`));
  const notes = [...(held.length ? ['previous data kept for ' + held.join(', ')] : []),
    ...(moves.length ? ['large move kept back, check the news: ' + moves.join('; ')] : []),
    ...(actions.length ? ['possible split or bonus, record it in /v1/corporate-actions: ' + actions.join(', ')] : [])];
  return notes.length ? { status: 'degraded', note: notes.join('; ') } : { status: 'done' };
}

/** Postcondition: the feed run reported a usable state. */
export function verifyFeed(output) {
  const result = lastJson(output);
  if (!result || typeof result !== 'object' || Array.isArray(result)) return { status: 'failed', note: 'no feed report' };
  // a feed in back-off after a failed fetch did not collect anything: counting it as done would hide an outage forever
  return /fail|backoff/.test(String(result.state)) ? { status: 'failed', note: 'feed ' + result.state } : { status: 'done' };
}

export function runProcess(step, { cwd = ROOT } = {}) {
  return new Promise(done => {
    const child = spawn(step.cmd, step.args, { cwd, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const keep = chunk => { output = (output + chunk.toString()).slice(-65536); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    const timer = setTimeout(() => { child.kill(); output += '\n[timed out]'; }, step.timeoutMs ?? 300_000);
    const tail = () => output.trim().split('\n').slice(-3).join(' | ').slice(0, 400);
    child.on('close', code => { clearTimeout(timer); done({ code: code ?? 1, tail: tail(), output }); });
    child.on('error', () => { clearTimeout(timer); done({ code: 127, tail: 'could not start ' + step.cmd, output: '' }); });
  });
}

export function runHttp(step, env = process.env, fetchImpl = fetch) {
  const base = (env.API_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
  const headers = { 'Content-Type': 'application/json' };
  if (step.role) {
    const principal = JSON.parse(env.PRINCIPALS_JSON || '[]').filter(p => p.role === step.role);
    if (principal.length !== 1) return Promise.resolve({ code: 1, tail: `needs exactly one ${step.role} credential` });
    headers.Authorization = 'Bearer ' + principal[0].token;
    // once a day by default (a same-day rerun replays the answer); a step whose work is naturally repeatable (triage of
    // whatever arrived since) takes a fresh key per run instead
    headers['Idempotency-Key'] = 'cycle-' + step.id + '-' + (step.freshKey ? new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 17) : new Date().toISOString().slice(0, 10));
  }
  return fetchImpl(base + step.path, { method: step.method || 'GET', headers, redirect: 'error', body: step.method === 'POST' ? '{}' : undefined,
    signal: AbortSignal.timeout(15_000) })
    .then(async r => ({ code: r.ok ? 0 : 1, tail: `HTTP ${r.status} ${(await r.text()).slice(0, 200)}` }))
    .catch(error => ({ code: 1, tail: 'unreachable: ' + (error.cause?.code || error.name) }));
}

/** RELEASE-01 worker gate: the bot's identity comes from its own code (--describe: model, prompt version, code
 *  fingerprint) and the backend says whether exactly that is an authorised release now. Null when allowed, else why not. */
export async function releaseCheck(gate, { run = runProcess, env = process.env, fetchImpl = fetch } = {}) {
  const described = await run({ cmd: gate.cmd, args: gate.args, timeoutMs: 60_000 });
  const id = described.code === 0 ? lastJson(described.output ?? '') : null;
  if (!id?.model || !id.promptVersion || !id.codeFingerprint) return 'could not read the bot\'s release identity (--describe)';
  const evaluator = JSON.parse(env.PRINCIPALS_JSON || '[]').filter(p => p.role === 'evaluator');
  if (evaluator.length !== 1) return 'needs exactly one evaluator credential for the release check';
  const base = (env.API_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
  try {
    const r = await fetchImpl(base + '/v1/releases/check', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + evaluator[0].token },
      body: JSON.stringify({ botId: gate.botId, model: id.model, promptVersion: id.promptVersion, codeFingerprint: id.codeFingerprint }) });
    const answer = JSON.parse(await r.text());
    if (!r.ok) return `release check refused (HTTP ${r.status})`;
    if (answer.allowed) return null;
    return answer.reason === 'version-not-authorised'
      ? `its code or rule differs from the authorised release v${answer.authorised?.version}: register, evaluate and activate a new release before it trades`
      : `no authorised release (${answer.reason})`;
  } catch (error) { return 'release check unreachable: ' + (error.cause?.code || error.name); }
}

/** COST-01 enforced: may this bot's department spend model tokens today? Null when yes (or unlimited), else why not.
 *  An unreachable or refused check is a 'no' too: model spending never proceeds on missing facts. */
export async function computeCheck(gate, { env = process.env, fetchImpl = fetch } = {}) {
  const evaluator = JSON.parse(env.PRINCIPALS_JSON || '[]').filter(p => p.role === 'evaluator');
  if (evaluator.length !== 1) return 'needs exactly one evaluator credential for the compute check';
  const base = (env.API_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
  try {
    const r = await fetchImpl(base + '/v1/compute/allowance', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + evaluator[0].token }, body: JSON.stringify({ botId: gate.botId }) });
    if (!r.ok) return `compute check refused (HTTP ${r.status})`;
    const a = JSON.parse(await r.text());
    return a.allowed ? null : `department ${a.departmentId} used ${a.usedTodayTokens} of its ${a.budgetTokensPerDay} tokens today; it runs again tomorrow`;
  } catch (error) { return 'compute check unreachable: ' + (error.cause?.code || error.name); }
}

export const ESCALATE_AFTER = 3;          // consecutive failed cycles before a step becomes an incident
export const BACKOFF_MS = [30_000, 90_000]; // waits between retries of a transient step

/** Runbook for one step: bounded retries with back-off, then the step's postcondition decides the outcome. */
async function attempt(step, { run, http, sleep }) {
  let last = null;
  for (let tries = 0; tries <= (step.retries ?? 0); tries++) {
    if (tries) await sleep(BACKOFF_MS[Math.min(tries - 1, BACKOFF_MS.length - 1)]);
    const r = step.kind === 'http' ? await http(step) : await run(step);
    let outcome = { status: (step.okCodes ?? [0]).includes(r.code) ? 'done' : 'failed', exitCode: r.code, summary: r.tail, tries: tries + 1 };
    if (outcome.status === 'done' && step.verify) {
      const check = step.verify(r.output ?? '');
      outcome = { ...outcome, status: check.status, ...(check.note ? { reason: check.note } : {}) };
    }
    last = outcome;
    if (outcome.status !== 'failed') break; // done or degraded: retrying would not change a deliberate data decision
  }
  return last;
}

/** Default escalation: a WARNING incident in the backend (never 'critical', which would halt new risk); when the
 *  backend itself is unreachable, a line in the local alert outbox instead. */
export async function escalate(step, streak, summary, env = process.env, fetchImpl = fetch) {
  const description = `Automatic cycle: step '${step.id}' failed ${streak} runs in a row. Last result: ${String(summary ?? '').slice(0, 300)}`;
  const evaluator = JSON.parse(env.PRINCIPALS_JSON || '[]').filter(p => p.role === 'evaluator');
  const base = (env.API_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
  if (evaluator.length === 1 && step.id !== 'backend-health') {
    try {
      const r = await fetchImpl(base + '/v1/incidents', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + evaluator[0].token,
          'Idempotency-Key': `cycle-escalation-${step.id}-${new Date().toISOString().slice(0, 10)}` },
        body: JSON.stringify({ description, severity: 'warning' }) });
      if (r.ok) return 'incident';
    } catch { /* fall through to the local outbox */ }
  }
  const outbox = resolve(env.ALERT_OUTBOX || join(ROOT, '.local', 'alerts', 'outbox.jsonl'));
  await mkdir(dirname(outbox), { recursive: true });
  await writeFile(outbox, JSON.stringify({ at: new Date().toISOString(), severity: 'warning', rule: 'cycle-escalation', subject: step.id, message: description }) + '\n', { flag: 'a' });
  return 'outbox';
}

export async function runCycle({ steps, journalPath, streaksPath = join(dirname(journalPath), 'streaks.json'), force = false, run = runProcess,
  http = runHttp, now = () => new Date(), sleep = ms => new Promise(r => setTimeout(r, ms)), escalateStep = escalate,
  gate = g => releaseCheck(g, { run }), budget = g => computeCheck(g) }) {
  let journal = { startedAt: now().toISOString(), steps: {} };
  try { journal = JSON.parse(await readFile(journalPath, 'utf8')); } catch { /* first run today */ }
  let streaks = {};
  try { streaks = JSON.parse(await readFile(streaksPath, 'utf8')); } catch { /* no history yet */ }
  const results = [];
  for (const step of steps) {
    const previous = journal.steps[step.id];
    if (!force && previous?.status === 'done' && !step.critical) { results.push({ id: step.id, status: 'done', resumed: true }); continue; }
    let outcome;
    if (step.skip) outcome = { status: 'skipped', reason: step.skip };
    else if (step.requires && !existsSync(step.requires)) outcome = { status: 'skipped', reason: 'missing ' + step.requires.split(/[\\/]/).slice(-2).join('/') };
    else {
      // a release-controlled bot whose code is not the authorised release does not run at all (it would be refused anyway)
      const refused = step.releaseGate ? await gate(step.releaseGate) : null;
      // a used-up compute budget is a deliberate stop for today, not a failure: the step simply waits for tomorrow
      const spent = !refused && step.computeGate ? await budget(step.computeGate) : null;
      outcome = refused ? { status: 'failed', reason: 'release gate: ' + refused }
        : spent ? { status: 'skipped', reason: 'compute budget: ' + spent } : await attempt(step, { run, http, sleep });
    }
    if (outcome.status === 'failed') {
      const streak = (streaks[step.id]?.failures ?? 0) + 1;
      streaks[step.id] = { failures: streak, escalated: streaks[step.id]?.escalated ?? false };
      if (streak >= ESCALATE_AFTER && !streaks[step.id].escalated) {
        outcome.escalated = await escalateStep(step, streak, outcome.summary);
        streaks[step.id].escalated = true;
      }
    } else if (outcome.status === 'done' || outcome.status === 'degraded') streaks[step.id] = { failures: 0, escalated: false };
    journal.steps[step.id] = { ...outcome, at: now().toISOString(), attempts: (previous?.attempts ?? 0) + (outcome.tries ?? 0) };
    results.push({ id: step.id, ...outcome });
    await mkdir(dirname(journalPath), { recursive: true });
    await writeFile(journalPath, JSON.stringify(journal, null, 2) + '\n');
    await writeFile(streaksPath, JSON.stringify(streaks, null, 2) + '\n');
    if (step.critical && outcome.status !== 'done') { results.push({ id: 'cycle', status: 'stopped', reason: step.id + ' failed' }); break; }
  }
  journal.finishedAt = now().toISOString();
  await writeFile(journalPath, JSON.stringify(journal, null, 2) + '\n');
  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = new Set(process.argv.slice(2));
  const steps = await planSteps({ withModel: args.has('--with-model') });
  const journalPath = join(ROOT, '.local', 'cycles', new Date().toISOString().slice(0, 10) + '.json');
  const results = await runCycle({ steps, journalPath, force: args.has('--force') });
  for (const r of results) console.log(`${r.status.padEnd(8)} ${r.id}${r.resumed ? ' (already done today)' : ''}${r.tries > 1 ? ` (after ${r.tries} tries)` : ''}`
    + `${r.escalated ? ' [escalated: ' + r.escalated + ']' : ''}${r.reason ? ' — ' + r.reason : ''}${r.summary ? ' — ' + String(r.summary).slice(0, 160) : ''}`);
  process.exitCode = results.some(r => r.status === 'failed' || r.status === 'stopped') ? 1 : 0;
}
