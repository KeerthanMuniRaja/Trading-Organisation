// Adds one trader credential bound to a bot (for example a new R&D bot the owner qualified), to .env. Owner-run.
//   node scripts/bot-credential.mjs --bot <id>          read-only: says whether it is present
//   node scripts/bot-credential.mjs --bot <id> --yes    adds it (previous .env kept in .local/env-backups); then restart the backend
// The token is generated here and never printed. Exactly one trader credential per bot.
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The .env text with one trader credential bound to botId added, or null when it is already there. */
export function addCredential(envText, botId, token = randomBytes(32).toString('base64url')) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(botId ?? '')) throw new Error('Give a bot id: --bot <id>');
  const lines = envText.split(/\r?\n/);
  const at = lines.findIndex(l => l.startsWith('PRINCIPALS_JSON='));
  if (at < 0) throw new Error('.env has no PRINCIPALS_JSON line');
  const principals = JSON.parse(lines[at].slice('PRINCIPALS_JSON='.length).trim().replace(/^'(.*)'$/, '$1') || '[]');
  const bound = principals.filter(p => p.role === 'trader' && p.botId === botId);
  if (bound.length > 1) throw new Error(`More than one trader credential is bound to ${botId}; fix .env by hand`);
  if (bound.length) return null;
  principals.push({ id: 'local-trader-' + botId, role: 'trader', token, botId });
  lines[at] = `PRINCIPALS_JSON='${JSON.stringify(principals)}'`;
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2), at = args.indexOf('--bot');
  const botId = at >= 0 ? args[at + 1] : args.find(a => a.startsWith('--bot='))?.slice(6);
  const path = join(ROOT, '.env');
  const updated = addCredential(await readFile(path, 'utf8'), botId);
  if (!updated) { console.log(`A trader credential bound to ${botId} is already present; nothing changed.`); return; }
  if (!args.includes('--yes')) { console.log(`No trader credential is bound to ${botId}. Rerun with --yes to add one.`); return; }
  await mkdir(join(ROOT, '.local', 'env-backups'), { recursive: true });
  const backup = join(ROOT, '.local', 'env-backups', `.env.${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await copyFile(path, backup);
  await writeFile(path, updated, { mode: 0o600 });
  console.log(`Added a trader credential bound to ${botId} (token not printed; previous .env kept in ${backup}). Restart the backend so it loads it.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
