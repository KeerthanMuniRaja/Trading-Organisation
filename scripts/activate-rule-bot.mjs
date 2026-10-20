// Brings the model-free rule bot (integrations/trading-desk/rule_bot.py) into the organisation, step by step, with the
// same controls as any bot: a bot-bound trader credential, a fitness report from the regime study, a release for the
// exact rule and code, an independent evaluation, activation, and owner qualification for paper trading.
//   node --env-file=.env scripts/activate-rule-bot.mjs plan                      read-only: what would happen
//   node --env-file=.env scripts/activate-rule-bot.mjs credential --yes          adds the bot's trader credential and
//                                                                                RULE_BOT_ID to .env (backup first);
//                                                                                restart the backend afterwards
//   node --env-file=.env scripts/activate-rule-bot.mjs apply --yes               creates, evaluates, activates, qualifies
// Every apply step is idempotent: a rerun returns the earlier results and changes nothing.
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PY = process.env.CYCLE_PYTHON || join(ROOT, '.local', 'replay-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
export const BOT = { id: 'momentum-rules', name: 'Momentum rules', department: 'desk', specialty: 'momentum-allocation', method: 'relative-momentum-rules',
  contribution: 'Model-free member: holds the three strongest shares by 6-month return, rebalanced monthly. Keeps the trading pipeline working without a model.' };
const STUDY_RULE = 'top3-momentum-6m';

/** The rule's release identity, from the rule bot itself (single source of truth). */
export async function identity(python = PY) {
  const { stdout } = await promisify(execFile)(python, [join(ROOT, 'integrations', 'trading-desk', 'rule_bot.py'), '--describe']);
  return JSON.parse(stdout);
}

/** The fitness report the evaluator files: the rule's monthly record against the equal-weight basket in the regime study. */
export function fitnessFrom(study, model, botId = BOT.id) {
  const all = study?.byRule?.[STUDY_RULE]?.['all months'];
  if (!all?.months) throw new Error(`The regime study has no '${STUDY_RULE}' record; run regime_study.py first`);
  const lastDay = new Date(Date.UTC(Number(study.through.slice(0, 4)), Number(study.through.slice(5, 7)), 0)).toISOString().slice(0, 10);
  return { botId, role: 'allocator', baseline: 'equal-weight-basket', model, judged: all.months, wins: all.ahead, losses: all.behind,
    testName: `regime-study ${study.from}..${study.through} monthly vs basket (seen data)`, periodFrom: study.from + '-01', periodTo: lastDay };
}

/** Adds one trader credential bound to the bot, and RULE_BOT_ID, to the .env text. Returns null when both are present. */
export function withCredential(envText, botId = BOT.id, token = randomBytes(32).toString('base64url')) {
  const lines = envText.split(/\r?\n/);
  const at = lines.findIndex(l => l.startsWith('PRINCIPALS_JSON='));
  if (at < 0) throw new Error('.env has no PRINCIPALS_JSON line');
  const raw = lines[at].slice('PRINCIPALS_JSON='.length).trim().replace(/^'(.*)'$/, '$1');
  const principals = JSON.parse(raw || '[]');
  const bound = principals.filter(p => p.role === 'trader' && p.botId === botId);
  if (bound.length > 1) throw new Error(`More than one trader credential is bound to ${botId}; fix .env by hand`);
  let changed = false;
  if (!bound.length) {
    principals.push({ id: 'local-trader-' + botId, role: 'trader', token, botId });
    lines[at] = `PRINCIPALS_JSON='${JSON.stringify(principals)}'`;
    changed = true;
  }
  const named = lines.find(l => l.startsWith('RULE_BOT_ID='));
  if (named && named !== `RULE_BOT_ID=${botId}`) throw new Error(`RULE_BOT_ID already names another bot (${named.slice(12)})`);
  if (!named) {
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.push(`RULE_BOT_ID=${botId}`, '');
    changed = true;
  }
  return changed ? lines.join('\n') : null;
}

function principal(env, role, botId) {
  const found = JSON.parse(env.PRINCIPALS_JSON || '[]').filter(p => p.role === role && (botId ? p.botId === botId : !p.botId));
  if (found.length !== 1 || !found[0].token) throw new Error(`Configure exactly one ${role} credential${botId ? ` bound to ${botId}` : ''}`);
  return found[0].token;
}

function client(env, fetchImpl) {
  const base = (env.API_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
  if (!/^(https:\/\/[^/@?#]+|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?)$/.test(base)) throw new Error('Invalid backend API origin');
  return async (role, method, path, body, keyParts) => {
    const headers = { Authorization: 'Bearer ' + principal(env, role), 'Content-Type': 'application/json' };
    if (keyParts) headers['Idempotency-Key'] = 'rulebot-' + createHash('sha256').update(JSON.stringify(keyParts)).digest('hex').slice(0, 48);
    const r = await fetchImpl(base + path, { method, headers, redirect: 'error', ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text();
    if (!r.ok) throw new Error(`${path} refused (HTTP ${r.status}): ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  };
}

/** Creates (if needed), files fitness, registers, evaluates, activates and qualifies. Each step reports what it did. */
export async function apply(env, { fetchImpl = fetch, id, study, budgetPaise = '500000' }) {
  const call = client(env, fetchImpl), steps = [];
  const bots = await call('owner', 'GET', '/v1/bots');
  let bot = (Array.isArray(bots) ? bots : bots.bots ?? []).find(b => b.id === BOT.id);
  if (!bot) {
    await call('owner', 'POST', '/v1/bots', { ...BOT, budgetPaise }, ['bot', BOT.id]);
    bot = { state: 'school' };
    steps.push(['bot', `created ${BOT.id} (school, budget ${budgetPaise} paise)`]);
  } else steps.push(['bot', `exists (${bot.state})`]);
  const fitness = await call('evaluator', 'POST', '/v1/bots/fitness', fitnessFrom(study, id.model), ['fitness', id.model, study.from, study.through]);
  steps.push(['fitness', `${fitness.verdict}${fitness.pValue !== undefined ? ` (p=${fitness.pValue})` : ''}`]);
  const release = await call('owner', 'POST', '/v1/releases', { botId: BOT.id, model: id.model, promptVersion: id.promptVersion, codeFingerprint: id.codeFingerprint,
    notes: id.rule }, ['release', id.model, id.promptVersion, id.codeFingerprint]);
  steps.push(['release', `v${release.version}${release.duplicate ? ' (already registered)' : ''}`]);
  const evaluation = await call('evaluator', 'POST', '/v1/releases/evaluations', { releaseId: release.id, fitnessReportId: fitness.id }, ['evaluation', release.id, fitness.id]);
  steps.push(['evaluation', `active-eligible ${evaluation.activeEligible}`]);
  if (!evaluation.activeEligible) return { activated: false, steps, reason: 'The evaluation does not allow activation' };
  const view = await call('owner', 'POST', '/v1/releases/view', { botId: BOT.id });
  if (view.active !== release.id) {
    await call('owner', 'POST', '/v1/releases/stages', { releaseId: release.id, stage: 'active', reason: `Rule release ${id.promptVersion} evaluated ${fitness.verdict}` },
      ['stage', release.id, evaluation.id]);
    steps.push(['stage', 'active']);
  } else steps.push(['stage', 'already active']);
  if (bot.state === 'school' || bot.state === 'college') {
    await call('owner', 'POST', '/v1/releases/qualifications', { botId: BOT.id, reason: 'Model-free rule bot for live paper testing' }, ['qualify', release.id]);
    steps.push(['qualify', 'paper']);
  } else steps.push(['qualify', `already ${bot.state}`]);
  return { activated: true, steps };
}

async function main() {
  const [command = 'plan'] = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const yes = process.argv.includes('--yes');
  const budget = process.argv.find(a => a.startsWith('--budget-paise='))?.split('=')[1] ?? '500000';
  const id = await identity();
  const studyPath = join(ROOT, '.local', 'trading-desk', 'regime-study.json');
  const study = existsSync(studyPath) ? JSON.parse(await readFile(studyPath, 'utf8')) : null;
  if (command === 'plan') {
    const hasCredential = JSON.parse(process.env.PRINCIPALS_JSON || '[]').some(p => p.role === 'trader' && p.botId === BOT.id);
    console.log(JSON.stringify({ bot: BOT.id, release: id, fitness: study ? fitnessFrom(study, id.model) : 'regime study missing',
      credential: hasCredential ? 'present' : 'missing: run "credential --yes", then restart the backend',
      ruleBotId: process.env.RULE_BOT_ID ?? 'not set', next: hasCredential ? 'apply --yes' : 'credential --yes' }, null, 2));
    return;
  }
  if (!yes) throw new Error(`"${command}" changes things; rerun with --yes`);
  if (command === 'credential') {
    const path = join(ROOT, '.env');
    const updated = withCredential(await readFile(path, 'utf8'));
    if (!updated) { console.log('Credential and RULE_BOT_ID already present; nothing changed.'); return; }
    await mkdir(join(ROOT, '.local', 'env-backups'), { recursive: true });
    const backup = join(ROOT, '.local', 'env-backups', `.env.${new Date().toISOString().replace(/[:.]/g, '-')}`);
    await copyFile(path, backup);
    await writeFile(path, updated, { mode: 0o600 });
    console.log(`Added a trader credential bound to ${BOT.id} and RULE_BOT_ID (token not printed; previous .env kept in ${backup}). Restart the backend so it loads the credential.`);
    return;
  }
  if (command === 'apply') {
    if (!study) throw new Error('Run regime_study.py first: the fitness report comes from it');
    console.log(JSON.stringify(await apply(process.env, { id, study, budgetPaise: budget }), null, 2));
    return;
  }
  throw new Error(`Unknown command "${command}" (plan, credential, apply)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
