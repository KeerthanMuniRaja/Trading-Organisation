// One-time setup of the debate desk (DEBATE-01): two challenger bots, a bull and a bear, each with its own trader
// credential, so they can argue proposals before review. They start with zero budget: they never trade, they challenge.
//   node --env-file=.env scripts/debate-setup.mjs plan          read-only: what is missing
//   node --env-file=.env scripts/debate-setup.mjs apply --yes   creates the bots (owner), adds their credentials and the
//                                                               DEBATE_*_BOT settings to .env (backup kept); restart the backend
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addCredential } from './bot-credential.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEBATERS = [
  { setting: 'DEBATE_BULL_BOT', id: 'debate-bull', name: 'Bull researcher', specialty: 'bull-case', contribution: 'Argues the case for each proposal, with its caveats, before review' },
  { setting: 'DEBATE_BEAR_BOT', id: 'debate-bear', name: 'Bear researcher', specialty: 'bear-case', contribution: 'Argues the strongest evidenced case against each proposal before review' },
];

/** The .env text with both debaters' credentials and settings, or null when nothing is missing. */
export function withDebaters(envText) {
  let text = envText, changed = false;
  for (const d of DEBATERS) {
    const next = addCredential(text, d.id);
    if (next) { text = next; changed = true; }
    if (!text.split(/\r?\n/).some(l => l.startsWith(d.setting + '='))) {
      const lines = text.split(/\r?\n/);
      while (lines.length && lines[lines.length - 1] === '') lines.pop();
      text = [...lines, `${d.setting}=${d.id}`, ''].join('\n');
      changed = true;
    }
  }
  return changed ? text : null;
}

async function createBots(env, fetchImpl = fetch) {
  const owner = JSON.parse(env.PRINCIPALS_JSON || '[]').filter(p => p.role === 'owner');
  if (owner.length !== 1) throw new Error('Configure exactly one owner credential');
  const base = (env.API_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
  const headers = { Authorization: 'Bearer ' + owner[0].token, 'Content-Type': 'application/json' };
  const existing = await (await fetchImpl(base + '/v1/bots', { headers })).json();
  const out = [];
  for (const d of DEBATERS) {
    if (existing.some(b => b.id === d.id)) { out.push(`${d.id}: exists`); continue; }
    const body = JSON.stringify({ id: d.id, name: d.name, department: 'research', specialty: d.specialty, method: 'model-debate', contribution: d.contribution, budgetPaise: '0' });
    const r = await fetchImpl(base + '/v1/bots', { method: 'POST', body, headers: { ...headers, 'Idempotency-Key': 'debate-' + createHash('sha256').update(body).digest('hex').slice(0, 48) } });
    if (!r.ok) throw new Error(`/v1/bots refused (HTTP ${r.status}): ${(await r.text()).slice(0, 200)}`);
    out.push(`${d.id}: created (zero budget)`);
  }
  return out;
}

async function main() {
  const [command = 'plan'] = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const path = join(ROOT, '.env'), updated = withDebaters(await readFile(path, 'utf8'));
  if (command === 'plan') {
    console.log(updated ? 'Missing: debater credentials or settings in .env. Run "apply --yes", then restart the backend.' : 'The debaters are configured in .env.');
    return;
  }
  if (command !== 'apply' || !process.argv.includes('--yes')) throw new Error('Usage: debate-setup.mjs plan | apply --yes');
  console.log((await createBots(process.env)).join('\n'));
  if (!updated) { console.log('.env already has the debaters; nothing changed.'); return; }
  await mkdir(join(ROOT, '.local', 'env-backups'), { recursive: true });
  const backup = join(ROOT, '.local', 'env-backups', `.env.${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await copyFile(path, backup);
  await writeFile(path, updated, { mode: 0o600 });
  console.log(`Added the debaters' credentials and settings (tokens not printed; previous .env kept in ${backup}). Restart the backend.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
