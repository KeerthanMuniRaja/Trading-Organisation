import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { plan, write, KEEP_BACKUPS } from './export-data.mjs';

async function put(root, path, text = 'x') { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); }

test('only data folders are exported; secrets, keys, logs, models and caches never are', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'export-'));
  try {
    const local = join(dir, '.local');
    for (const p of ['trading-desk/daily/SBIN.NS-1d.json', 'world/latest.json', 'cycles/2026-10-21.json', 'feed-livemint.json', 'nse-holidays.json',
      'knowledge/index-meta.json']) await put(local, p, '{}');
    for (const p of ['credentials.json', 'owner-signing-key.pem', 'env-backups/.env.1', 'models/qwen.gguf', 'replay-venv/lib/x.py', 'backend-run.log',
      'push-plan.json', 'knowledge/index.sqlite', 'organisation-starter/creds.json', 'trading-desk/__pycache__/a.pyc', 'feeds/token-cache.json'])
      await put(local, p, 'secret');
    for (let k = 1; k <= KEEP_BACKUPS + 2; k++) await put(local, `backups/2026-10-${String(k).padStart(2, '0')}T000000Z/manifest.json`, '{}');
    const p = await plan(local);
    const paths = p.files.map(f => f.path);
    assert.ok(['trading-desk/daily/SBIN.NS-1d.json', 'world/latest.json', 'cycles/2026-10-21.json', 'feed-livemint.json', 'nse-holidays.json',
      'knowledge/index-meta.json'].every(x => paths.includes(x)));
    for (const bad of ['credentials', '.pem', '.env', 'models/', 'venv', '.log', 'push-plan', 'index.sqlite', 'organisation-starter', '.pyc', 'token-cache'])
      assert.ok(!paths.some(x => x.includes(bad)), bad);
    assert.equal(p.backupsKept.length, KEEP_BACKUPS);
    assert.equal(p.backupsLeftOut, 2);
    assert.ok(!paths.includes('backups/2026-10-01T000000Z/manifest.json')); // the oldest stay on the machine
    assert.ok(p.skipped.some(s => s.path === 'feeds/token-cache.json')); // a suspicious name inside a data folder is reported, not copied
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the export mirrors into the target with a manifest, and a secret anywhere stops it before writing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'export-'));
  try {
    const local = join(dir, '.local'), to = join(dir, 'data-repo');
    await put(local, 'digests/2026-10-20.md', '# Digest');
    await put(to, 'local/digests/old-file.md', 'stale');
    const r = await write(local, to, { commit: 'abc123', now: new Date('2026-10-21T12:00:00Z') });
    assert.equal(r.written, true);
    assert.equal(await readFile(join(to, 'local', 'digests', '2026-10-20.md'), 'utf8'), '# Digest');
    assert.equal(existsSync(join(to, 'local', 'digests', 'old-file.md')), false); // removed locally, removed in the copy
    const manifest = JSON.parse(await readFile(join(to, 'MANIFEST.json'), 'utf8'));
    assert.deepEqual([manifest.codeCommit, manifest.files, manifest.list[0].path, manifest.list[0].sha256.length], ['abc123', 1, 'digests/2026-10-20.md', 64]);
    assert.match(await readFile(join(to, 'README.md'), 'utf8'), /Keep this repository private/);
    // a credential inside an allowed file: nothing is written, and the finding names the rule, never the secret
    const fake = ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' '); // assembled, so this file holds no key header
    await put(local, 'cycles/2026-10-21.json', JSON.stringify({ note: fake }));
    const refused = await write(local, to);
    assert.equal(refused.written, false);
    assert.ok(refused.findings.length >= 1 && refused.findings[0].path === 'local/cycles/2026-10-21.json');
    assert.ok(!JSON.stringify(refused.findings).includes(fake));
    assert.equal(existsSync(join(to, 'local', 'digests', '2026-10-20.md')), true); // the previous good export is untouched
  } finally { await rm(dir, { recursive: true, force: true }); }
});
