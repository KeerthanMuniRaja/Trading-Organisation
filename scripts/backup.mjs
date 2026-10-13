// Backup, verification and restore of the embedded (PGlite) organisation database. Part of OPS-01.
//   create  [--out .local/backups]   API must be stopped. Writes database.tar.gz plus manifest.json: schema versions,
//                                    row counts, ledger balances and the audit-chain head. No credentials or .env.
//   verify  <backup-dir>             Restores the archive IN MEMORY and re-checks everything against the manifest:
//                                    archive hash, audit hash chain, every journal balanced, counts and balances.
//   restore <backup-dir> <new-dir>   Verifies, then writes the database into a new or empty directory only; the live
//                                    database is never overwritten. Point DATABASE_PATH at it to use it.
// External PostgreSQL (DATABASE_URL) is out of scope: use pg_dump with that provider's tooling.
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { digest } from '../backend/dist/src/core.js';

export const FORMAT = 'organisation-backup-v1';
const COUNTED = ['journals', 'entries', 'audit_events', 'evidence', 'sources', 'bots', 'lessons', 'orders', 'fills', 'positions',
  'trade_signals', 'bot_fitness_reports', 'evidence_claims', 'paper_performance_snapshots', 'departments', 'hackathons'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** Facts that must survive a backup unchanged. Read-only queries; tables missing in older schemas are skipped. */
export async function summarise(pg) {
  const schema = (await pg.query('SELECT version,checksum FROM schema_versions ORDER BY version')).rows;
  const counts = {};
  for (const table of COUNTED) {
    if ((await pg.query('SELECT to_regclass($1) AS t', ['public.' + table])).rows[0].t)
      counts[table] = Number((await pg.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n);
  }
  const balances = Object.fromEntries((await pg.query('SELECT account,SUM(amount)::text AS total FROM entries GROUP BY account ORDER BY account'))
    .rows.map(r => [r.account, r.total]));
  const unbalanced = Number((await pg.query(`SELECT COUNT(*)::int AS n FROM (SELECT journal_id FROM entries GROUP BY journal_id
    HAVING SUM(amount)<>0) x`)).rows[0].n);
  let previous = 'GENESIS', events = 0, auditValid = true;
  for (const row of (await pg.query('SELECT * FROM audit_events ORDER BY sequence')).rows) {
    const hash = digest({ id: row.id, actor: row.actor, action: row.action, entity: row.entity, payload: row.payload, previous });
    if (row.previous_hash !== previous || row.hash !== hash) { auditValid = false; break; }
    previous = row.hash; events++;
  }
  return { schemaVersions: schema.map(r => r.version), schemaChecksums: Object.fromEntries(schema.map(r => [r.version, r.checksum])),
    counts, balances, unbalancedJournals: unbalanced, audit: { valid: auditValid, events, head: previous } };
}

/** True when something already listens on the API port (a running API must never share the database directory). */
export function apiListening(host = process.env.HOST || '127.0.0.1', port = Number(process.env.PORT || 3000)) {
  return new Promise(done => {
    const socket = net.connect({ host, port }); socket.setTimeout(1500);
    const finish = value => { socket.destroy(); done(value); };
    socket.once('connect', () => finish(true)).once('error', () => finish(false)).once('timeout', () => finish(false));
  });
}

export async function createBackup({ dataDir = process.env.DATABASE_PATH || '.data/paper', outRoot = '.local/backups', now = new Date(),
  apiRunning = apiListening } = {}) {
  if (process.env.DATABASE_URL) throw new Error('DATABASE_URL is set: back up external PostgreSQL with pg_dump instead');
  if (await apiRunning()) throw new Error('The API is running: stop it first so the database is not copied mid-write');
  const source = resolve(dataDir);
  if (!(await readdir(source).catch(() => [])).length) throw new Error('No database found at ' + source);
  const pg = new PGlite(source);
  try {
    const summary = await summarise(pg);
    if (!summary.audit.valid) throw new Error('Audit chain is already broken in the live database; investigate before backing up');
    if (summary.unbalancedJournals) throw new Error('Unbalanced journals found in the live database; investigate before backing up');
    const archive = Buffer.from(await (await pg.dumpDataDir('gzip')).arrayBuffer());
    const directory = resolve(outRoot, 'backup-' + now.toISOString().replace(/[:.]/g, '-'));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'database.tar.gz'), archive);
    const manifest = { format: FORMAT, createdAt: now.toISOString(), source: 'pglite', archive: 'database.tar.gz', archiveBytes: archive.length,
      archiveSha256: sha256(archive), ...summary,
      note: 'Contains the paper ledger, evidence and audit history. No credentials, .env or signing keys are included; store those separately.' };
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    return { directory, manifest };
  } finally { await pg.close(); }
}

async function load(directory) {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  if (manifest.format !== FORMAT) throw new Error('Not a recognised backup');
  const archive = await readFile(join(directory, manifest.archive));
  return { manifest, archive };
}

export async function verifyBackup(directory, migrationsDir = 'db/migrations') {
  const { manifest, archive } = await load(resolve(directory));
  const problems = [];
  if (sha256(archive) !== manifest.archiveSha256) problems.push('archive hash does not match the manifest');
  let restored = null;
  if (!problems.length) {
    const pg = new PGlite({ loadDataDir: new Blob([archive]) });
    try { restored = await summarise(pg); } finally { await pg.close(); }
    if (!restored.audit.valid) problems.push('audit hash chain is broken');
    if (restored.unbalancedJournals) problems.push('unbalanced journals');
    for (const key of ['counts', 'balances', 'audit', 'schemaChecksums'])
      if (JSON.stringify(restored[key]) !== JSON.stringify(manifest[key])) problems.push(`${key} differ from the manifest`);
  }
  const files = (await readdir(resolve(migrationsDir))).filter(n => /^\d+_.+\.sql$/.test(n)).sort();
  const current = Object.fromEntries(await Promise.all(files.map(async n => [Number(n.split('_')[0]), digest(await readFile(resolve(migrationsDir, n), 'utf8'))])));
  const changed = Object.entries(manifest.schemaChecksums).filter(([v, c]) => current[v] && current[v] !== c).map(([v]) => Number(v));
  if (changed.length) problems.push(`migrations ${changed.join(', ')} changed since the backup; this code cannot open it`);
  const pending = Object.keys(current).map(Number).filter(v => !(v in manifest.schemaChecksums));
  return { valid: !problems.length, problems, createdAt: manifest.createdAt, auditEvents: restored?.audit.events ?? null,
    balances: restored?.balances ?? null, pendingMigrationsOnOpen: pending };
}

export async function restoreBackup(directory, target) {
  const check = await verifyBackup(directory);
  if (!check.valid) throw new Error('Backup failed verification: ' + check.problems.join('; '));
  const destination = resolve(target);
  if ((await readdir(destination).catch(() => [])).length) throw new Error('Target directory is not empty; restore only into a new directory');
  const { archive } = await load(resolve(directory));
  await mkdir(destination, { recursive: true });
  const pg = new PGlite(destination, { loadDataDir: new Blob([archive]) });
  try {
    const after = await summarise(pg);
    if (!after.audit.valid || after.audit.head !== (await load(resolve(directory))).manifest.audit.head) throw new Error('Restored database does not match the backup');
  } finally { await pg.close(); }
  return { restoredTo: destination, ...check, next: `Set DATABASE_PATH=${destination} to use it; the live database was not touched.` };
}

async function main([command, ...args]) {
  if (command === 'create') {
    const out = args[0] === '--out' && args[1] ? args[1] : '.local/backups';
    const { directory, manifest } = await createBackup({ outRoot: out });
    console.log(JSON.stringify({ directory, archiveBytes: manifest.archiveBytes, auditEvents: manifest.audit.events, balances: manifest.balances }, null, 2));
  } else if (command === 'verify' && args[0]) {
    const result = await verifyBackup(args[0]);
    console.log(JSON.stringify(result, null, 2));
    if (!result.valid) process.exitCode = 1;
  } else if (command === 'restore' && args[0] && args[1]) {
    console.log(JSON.stringify(await restoreBackup(args[0], args[1]), null, 2));
  } else {
    console.log('Usage: backup.mjs create [--out DIR] | verify BACKUP_DIR | restore BACKUP_DIR NEW_DATA_DIR');
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
