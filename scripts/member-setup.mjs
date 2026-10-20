// One-time setup of a ready-made member (owner-run): its bot (zero budget), a trader credential bound to it, and the
// .env setting that names it to the cycle. A member then earns trading the normal way (shadow record, release, approvals).
//   node --env-file=.env scripts/member-setup.mjs plan                       what is missing, for every preset
//   node --env-file=.env scripts/member-setup.mjs apply <preset> --yes       create it (backup of .env kept); restart the backend
// Presets: tradingagents (the TradingAgents member), debaters (the bull and bear challengers).
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addCredential } from './bot-credential.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PRESETS = {
  tradingagents: [{ setting: 'TA_BOT_ID', id: 'tradingagents', name: 'TradingAgents', department: 'desk', specialty: 'multi-agent-research', method: 'tradingagents',
    contribution: 'The open-source TradingAgents firm (analysts, debate, trader, risk team, portfolio manager) as one governed member' }],
  debaters: [
    { setting: 'DEBATE_BULL_BOT', id: 'debate-bull', name: 'Bull researcher', department: 'research', specialty: 'bull-case', method: 'model-debate',
      contribution: 'Argues the case for each proposal, with its caveats, before review' },
    { setting: 'DEBATE_BEAR_BOT', id: 'debate-bear', name: 'Bear researcher', department: 'research', specialty: 'bear-case', method: 'model-debate',
      contribution: 'Argues the strongest evidenced case against each proposal before review' }],
};

/** The .env text with the members' credentials and settings added, or null when nothing is missing. */
export function withMembers(envText, members) {
  let text = envText, changed = false;
  for (const m of members) {
    const next = addCredential(text, m.id);
    if (next) { text = next; changed = true; }
    if (!text.split(/\r?\n/).some(l => l.startsWith(m.setting + '='))) {
      const lines = text.split(/\r?\n/);
      while (lines.length && lines[lines.length - 1] === '') lines.pop();
      text = [...lines, `${m.setting}=${m.id}`, ''].join('\n');
      changed = true;
    }
  }
  return changed ? text : null;
}

export async function createBots(env, members, fetchImpl = fetch) {
  const owner = JSON.parse(env.PRINCIPALS_JSON || '[]').filter(p => p.role === 'owner');
  if (owner.length !== 1) throw new Error('Configure exactly one owner credential');
  const base = (env.API_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
  const headers = { Authorization: 'Bearer ' + owner[0].token, 'Content-Type': 'application/json' };
  const existing = await (await fetchImpl(base + '/v1/bots', { headers })).json();
  const out = [];
  for (const m of members) {
    if (existing.some(b => b.id === m.id)) { out.push(`${m.id}: exists`); continue; }
    const body = JSON.stringify({ id: m.id, name: m.name, department: m.department, specialty: m.specialty, method: m.method, contribution: m.contribution, budgetPaise: '0' });
    const r = await fetchImpl(base + '/v1/bots', { method: 'POST', body, headers: { ...headers, 'Idempotency-Key': 'member-' + createHash('sha256').update(body).digest('hex').slice(0, 48) } });
    if (!r.ok) throw new Error(`/v1/bots refused (HTTP ${r.status}): ${(await r.text()).slice(0, 200)}`);
    out.push(`${m.id}: created (school, zero budget)`);
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2), [command = 'plan', preset] = args.filter(a => !a.startsWith('--'));
  const path = join(ROOT, '.env'), text = await readFile(path, 'utf8');
  if (command === 'plan') {
    for (const [name, members] of Object.entries(PRESETS)) console.log(`${name.padEnd(14)} ${withMembers(text, members) ? 'not set up: apply ' + name + ' --yes' : 'set up in .env'}`);
    return;
  }
  const members = PRESETS[preset];
  if (command !== 'apply' || !members || !args.includes('--yes')) throw new Error(`Usage: member-setup.mjs plan | apply <${Object.keys(PRESETS).join('|')}> --yes`);
  console.log((await createBots(process.env, members)).join('\n'));
  const updated = withMembers(text, members);
  if (!updated) { console.log('.env already names these members; nothing changed.'); return; }
  await mkdir(join(ROOT, '.local', 'env-backups'), { recursive: true });
  const backup = join(ROOT, '.local', 'env-backups', `.env.${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await copyFile(path, backup);
  await writeFile(path, updated, { mode: 0o600 });
  console.log(`Added the credentials and settings for ${preset} (tokens not printed; previous .env kept in ${backup}). Restart the backend.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
