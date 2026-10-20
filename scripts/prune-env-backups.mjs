// The .env copies in .local/env-backups hold credentials. Keep only the newest few (owner-run).
//   node scripts/prune-env-backups.mjs [--keep 3]          read-only: lists what would be deleted
//   node scripts/prune-env-backups.mjs [--keep 3] --yes    deletes the older copies
// Only files named .env.* directly in that folder are considered; nothing else is touched.
import { readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The backups to delete: every .env.* copy except the `keep` newest. */
export async function plan(dir, keep) {
  if (!Number.isInteger(keep) || keep < 1) throw new Error('--keep must be a whole number of at least 1');
  if (!existsSync(dir)) return [];
  const copies = [];
  for (const name of await readdir(dir)) {
    const path = join(dir, name), info = await stat(path);
    if (info.isFile() && /^\.env[.][A-Za-z0-9._-]+$/.test(name)) copies.push({ name, path, at: info.mtimeMs });
  }
  return copies.sort((a, b) => b.at - a.at || a.name.localeCompare(b.name)).slice(keep);
}

async function main() {
  const args = process.argv.slice(2), at = args.indexOf('--keep');
  const keep = at >= 0 ? Number(args[at + 1]) : 3;
  const doomed = await plan(join(ROOT, '.local', 'env-backups'), keep);
  if (!doomed.length) { console.log(`Nothing to delete: at most ${keep} .env backup(s) exist.`); return; }
  if (!args.includes('--yes')) { console.log(`Would delete ${doomed.length} older .env backup(s), keeping the newest ${keep}:\n${doomed.map(d => '  ' + d.name).join('\n')}\nRerun with --yes.`); return; }
  for (const d of doomed) await rm(d.path);
  console.log(`Deleted ${doomed.length} older .env backup(s); kept the newest ${keep}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
