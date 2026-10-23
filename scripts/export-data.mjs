// Data export (DATA-01): copies the organisation's collected data and database backups into a separate PRIVATE git
// repository, so the work can continue on any machine from two repositories: the code (Trading-Organisation) and the
// data. Only an allowlist of data folders is copied; credentials, keys, .env copies, logs, the model file, virtual
// environments and caches never are. Every copied text file is checked with the project's secret scanner, and any
// finding stops the export before anything is written. Files over GitHub's limit are skipped and reported.
//   node scripts/export-data.mjs                         dry run: what would be copied
//   node scripts/export-data.mjs --write [--to <dir>]    mirror into <dir>/local and write MANIFEST.json
// The target is a clone of the private data repository (default .local/data-repo); committing and pushing it is a
// separate, deliberate step. Restoring: see the README written into the target.
import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanText } from './secret-scan.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// the data folders under .local that hold collected or computed information
export const FOLDERS = ['alerts', 'backups', 'claims', 'cycles', 'digests', 'feeds', 'intraday', 'knowledge', 'market-replay', 'model-benchmarks',
  'model-calls', 'model-eval', 'organisation-starter', 'paired-artifact-fixtures', 'practice-benchmarks', 'readiness', 'trading-desk', 'tradingagents', 'world'];
// integrations that keep their own state beside their code (exported as state/<name>, restored to integrations/<name>/.state)
export const STATE_DIRS = ['hermes', 'ruflo', 'skfolio'];
// single files directly under .local: feed configurations, the holiday file and verification reports
export const TOP_FILES = [/^feed-[a-z0-9-]+\.json$/, /^nse-holidays\.json$/, /^nifty50-fetch\.json$/, /^[a-z0-9-]+-verification(-[a-z]+)?\.json$/, /^demo-report\.json$/, /^owner-notes\.txt$/];
// never copied, wherever they appear
export const NEVER = [/(^|\/)\.env/, /credentials/i, /\.pem$/, /signing-key/i, /secret/i, /token/i, /\.log$/, /(^|\/)__pycache__\//, /\.pyc$/,
  /\.lock$/, // a run lock only means "running"; restoring one would block the next run
  /^local\/knowledge\/.*\.(sqlite|db)(-wal|-shm)?$/]; // the knowledge index is rebuilt from the rest (npm run knowledge -- build)
export const KEEP_BACKUPS = 4;          // the newest database backups; older ones stay on the machine
export const MAX_FILE_BYTES = 95 * 1024 * 1024; // GitHub refuses files over 100 MB
const TEXT = /\.(json|jsonl|md|txt|csv|yaml|yml|html|mjs|js|py)$/i;

async function walk(dir, out = []) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out); else if (e.isFile()) out.push(p);
  }
  return out;
}

/** What would be copied from the project at `root`: [{path in the data repository (local/... or state/<name>/...), source,
 *  bytes}], what was skipped and why, and the backups kept. */
export async function plan(root) {
  const local = join(root, '.local'), files = [], skipped = [];
  const backups = existsSync(join(local, 'backups')) ? (await readdir(join(local, 'backups'), { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name).sort() : [];
  const keptBackups = new Set(backups.slice(-KEEP_BACKUPS));
  const candidates = []; // [source, path in the data repository]
  for (const folder of FOLDERS) for (const f of await walk(join(local, folder))) candidates.push([f, 'local/' + relative(local, f).split('\\').join('/')]);
  for (const name of existsSync(local) ? await readdir(local) : []) if (TOP_FILES.some(r => r.test(name))) candidates.push([join(local, name), 'local/' + name]);
  for (const name of STATE_DIRS) {
    const dir = join(root, 'integrations', name, '.state');
    for (const f of await walk(dir)) candidates.push([f, `state/${name}/` + relative(dir, f).split('\\').join('/')]);
  }
  for (const [source, path] of candidates) {
    if (NEVER.some(r => r.test(path))) { skipped.push({ path, why: 'never exported' }); continue; }
    const parts = path.split('/');
    if (parts[1] === 'backups' && parts.length > 3 && !keptBackups.has(parts[2])) continue; // an older backup
    const bytes = (await stat(source)).size;
    if (bytes > MAX_FILE_BYTES) { skipped.push({ path, why: `over ${MAX_FILE_BYTES} bytes` }); continue; }
    files.push({ path, source, bytes });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { files, skipped, backupsKept: [...keptBackups], backupsLeftOut: backups.length - keptBackups.size };
}

/** Secret-scan every text file in the plan; returns findings (path, line, rule), never the matched text. */
export async function scanPlan(files) {
  const findings = [];
  for (const f of files) if (TEXT.test(f.path)) findings.push(...scanText(f.path, await readFile(f.source, 'utf8')));
  return findings;
}

const README = `# Organisation data (private)

The collected data and database backups of the trading organisation, exported by \`scripts/export-data.mjs\` in the code
repository. **Keep this repository private**: it holds licensed prices and publishers' headlines for personal research,
and the organisation's own records.

Not here, by design: \`.env\`, credentials and the owner signing key (keep your own safe copy), the model file
(download it again), virtual environments, logs and the knowledge index database (rebuilt from the rest).

## Continue on a new machine

1. Clone the code repository and this one.
2. Copy this repository's \`local/\` folder to the code repository's \`.local/\`, and each \`state/<name>/\` folder to
   \`integrations/<name>/.state/\` (hermes, ruflo, skfolio).
3. Put your \`.env\`, \`.local/credentials.json\` and \`.local/owner-signing-key.pem\` back from your safe copy.
4. Install as the code repository's README says (Node, the Python research environment, the model file).
5. Restore the newest backup into an empty folder:
   \`node scripts/backup.mjs restore .local/backups/<newest> .data/paper\`
   It is verified first: archive hash, audit chain, balanced journals, counts and balances.
6. Rebuild the knowledge index: \`npm run knowledge -- build\`.
7. Check with \`npm run preflight\`, then start.

\`MANIFEST.json\` lists every file with its size and SHA-256, the export time and the code commit it came from.
\`claude-memory/\` holds the working notes for Claude Code (copied by hand; the export leaves that folder alone).
`;

/** Mirror the plan into <to>/local and <to>/state (stale files removed), with MANIFEST.json and README.md. Stops on any
 *  secret finding. */
export async function write(root, to, { commit = null, now = new Date() } = {}) {
  const p = await plan(root);
  const findings = await scanPlan(p.files);
  if (findings.length) return { written: false, findings };
  await rm(join(to, 'local'), { recursive: true, force: true });
  await rm(join(to, 'state'), { recursive: true, force: true });
  const files = [];
  for (const f of p.files) {
    const target = join(to, ...f.path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await cp(f.source, target);
    files.push({ path: f.path, bytes: f.bytes, sha256: createHash('sha256').update(await readFile(target)).digest('hex') });
  }
  const manifest = { format: 'organisation-data-v1', exportedAt: now.toISOString(), codeCommit: commit, files: files.length,
    bytes: files.reduce((s, f) => s + f.bytes, 0), backupsKept: p.backupsKept, backupsLeftOut: p.backupsLeftOut, skipped: p.skipped, list: files };
  await writeFile(join(to, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(join(to, 'README.md'), README);
  return { written: true, files: files.length, bytes: manifest.bytes, skipped: p.skipped.length, backupsKept: p.backupsKept.length };
}

async function headCommit(root) {
  try {
    const head = (await readFile(join(root, '.git', 'HEAD'), 'utf8')).trim();
    return head.startsWith('ref: ') ? (await readFile(join(root, '.git', head.slice(5)), 'utf8')).trim().slice(0, 12) : head.slice(0, 12);
  } catch { return null; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), at = args.indexOf('--to');
  const to = resolve(at >= 0 ? args[at + 1] : join(ROOT, '.local', 'data-repo'));
  if (!args.includes('--write')) {
    const p = await plan(ROOT), findings = await scanPlan(p.files);
    const mb = p.files.reduce((s, f) => s + f.bytes, 0) / 1048576;
    const byFolder = {};
    for (const f of p.files) { const k = f.path.split('/').slice(0, 2).join('/'); byFolder[k] = (byFolder[k] ?? 0) + f.bytes; }
    console.log(JSON.stringify({ dryRun: true, files: p.files.length, megabytes: Math.round(mb * 10) / 10,
      byFolderMB: Object.fromEntries(Object.entries(byFolder).map(([k, v]) => [k, Math.round(v / 104857.6) / 10])),
      backupsKept: p.backupsKept, backupsLeftOut: p.backupsLeftOut, skipped: p.skipped, secretFindings: findings }, null, 2));
    process.exitCode = findings.length ? 1 : 0;
  } else {
    const r = await write(ROOT, to, { commit: await headCommit(ROOT) });
    console.log(JSON.stringify(r, null, 2));
    process.exitCode = r.written ? 0 : 1;
  }
}
