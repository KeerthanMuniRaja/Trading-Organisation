import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database, audit } from '../backend/dist/src/database.js';
import { journal } from '../backend/dist/src/treasury.js';
import { createBackup, createVerifiedBackup, verifyBackup, restoreBackup } from './backup.mjs';

const owner = { id: 'owner', role: 'owner' };
const stopped = async () => false;

async function liveDatabase(root) {
  const dir = join(root, 'live');
  const db = await Database.open(dir); // applies every migration, like the real API
  await db.transaction(async tx => {
    await journal(tx, 'owner-contribution', 'deposit:backup-test', { source: 'SBI', mode: 'paper' }, [['W1', 500000n], ['PRINCIPAL', -500000n]]);
    await audit(tx, owner, 'treasury.deposit', 'backup-test', { amountPaise: '500000' });
    await audit(tx, owner, 'organisation.note', 'backup-test', { note: 'second event' });
  });
  await db.close();
  return dir;
}

test('a backup restores in memory to exactly the same ledger, audit chain and schema', async () => {
  const root = await mkdtemp(join(tmpdir(), 'backup-'));
  try {
    const live = await liveDatabase(root);
    await assert.rejects(() => createBackup({ dataDir: live, outRoot: join(root, 'out'), apiRunning: async () => true }), /stop it first/);
    const { directory, manifest } = await createBackup({ dataDir: live, outRoot: join(root, 'out'), apiRunning: stopped, now: new Date('2026-10-13T12:00:00Z') });
    assert.equal(manifest.balances.W1, '500000');
    assert.equal(manifest.audit.events, 2);
    assert.equal(manifest.unbalancedJournals, 0);
    assert.ok(manifest.schemaVersions.includes(36));
    const text = await readFile(join(directory, 'manifest.json'), 'utf8');
    assert.doesNotMatch(text, /token|PRINCIPALS|PRIVATE KEY/i); // credentials are never part of a backup

    const check = await verifyBackup(directory);
    assert.deepEqual([check.valid, check.problems, check.auditEvents, check.pendingMigrationsOnOpen], [true, [], 2, []]);
    // create reads its own backup back before reporting success; a bad write fails at once, not on restore day
    const verified = await createVerifiedBackup({ dataDir: live, outRoot: join(root, 'out-2'), apiRunning: stopped });
    assert.equal(verified.verified, true);
    await assert.rejects(() => createVerifiedBackup({ dataDir: live, outRoot: join(root, 'out-3'), apiRunning: stopped },
      async () => ({ valid: false, problems: ['archive hash does not match the manifest'] })), /failed its own verification: archive hash/);

    const restored = join(root, 'restored');
    await assert.rejects(async () => { await mkdir(restored); await writeFile(join(restored, 'x'), 'occupied'); await restoreBackup(directory, restored); }, /not empty/);
    const result = await restoreBackup(directory, join(root, 'restored-2'));
    assert.equal(result.valid, true);
    const db = await Database.open(join(root, 'restored-2')); // the API's own open path accepts it
    const w1 = (await db.transaction(tx => tx.query("SELECT SUM(amount)::text AS v FROM entries WHERE account='W1'"))).rows[0].v;
    await db.close();
    assert.equal(w1, '500000');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a damaged archive or an edited manifest fails verification and cannot be restored', async () => {
  const root = await mkdtemp(join(tmpdir(), 'backup-'));
  try {
    const live = await liveDatabase(root);
    const { directory } = await createBackup({ dataDir: live, outRoot: join(root, 'out'), apiRunning: stopped });
    const manifestPath = join(directory, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    await writeFile(manifestPath, JSON.stringify({ ...manifest, balances: { ...manifest.balances, W1: '999999' } }));
    const edited = await verifyBackup(directory);
    assert.equal(edited.valid, false);
    assert.ok(edited.problems.some(p => /balances/.test(p)));
    await writeFile(manifestPath, JSON.stringify(manifest));
    const archive = await readFile(join(directory, 'database.tar.gz'));
    archive[archive.length >> 1] ^= 0xff;
    await writeFile(join(directory, 'database.tar.gz'), archive);
    const damaged = await verifyBackup(directory);
    assert.deepEqual(damaged.problems, ['archive hash does not match the manifest']);
    await assert.rejects(() => restoreBackup(directory, join(root, 'restored')), /failed verification/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
