import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { plan, write, KEEP_BACKUPS } from './export-data.mjs';

async function put(root, path, text = 'x') { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); }

test('only data folders and integration state are exported; secrets, keys, logs, locks, models and caches never are', async () => {
  const root = await mkdtemp(join(tmpdir(), 'export-'));
  try {
    for (const p of ['.local/trading-desk/daily/SBIN.NS-1d.json', '.local/world/latest.json', '.local/cycles/2026-10-21.json', '.local/feed-livemint.json',
      '.local/nse-holidays.json', '.local/knowledge/index-meta.json', '.local/organisation-starter/plan.json', '.local/owner-notes.txt',
      'integrations/skfolio/.state/academy.sqlite', 'integrations/ruflo/.state/state.json']) await put(root, p, '{}');
    for (const p of ['.local/credentials.json', '.local/owner-signing-key.pem', '.local/env-backups/.env.1', '.local/models/qwen.gguf',
      '.local/replay-venv/lib/x.py', '.local/backend-run.log', '.local/push-plan.json', '.local/knowledge/index.sqlite', '.local/market-replay-cache/cookies.db',
      '.local/trading-desk/__pycache__/a.pyc', '.local/feeds/token-cache.json', 'integrations/skfolio/.state/run.lock', '.env']) await put(root, p, 'secret');
    for (let k = 1; k <= KEEP_BACKUPS + 2; k++) await put(root, `.local/backups/2026-10-${String(k).padStart(2, '0')}T000000Z/manifest.json`, '{}');
    const p = await plan(root);
    const paths = p.files.map(f => f.path);
    for (const good of ['local/trading-desk/daily/SBIN.NS-1d.json', 'local/world/latest.json', 'local/cycles/2026-10-21.json', 'local/feed-livemint.json',
      'local/nse-holidays.json', 'local/knowledge/index-meta.json', 'local/organisation-starter/plan.json', 'local/owner-notes.txt',
      'state/skfolio/academy.sqlite', 'state/ruflo/state.json']) assert.ok(paths.includes(good), good); // the skfolio academy database is data
    for (const bad of ['credentials', '.pem', '.env', 'models/', 'venv', '.log', 'push-plan', 'index.sqlite', 'cookies', '.pyc', 'token-cache', '.lock'])
      assert.ok(!paths.some(x => x.includes(bad)), bad);
    assert.equal(p.backupsKept.length, KEEP_BACKUPS);
    assert.equal(p.backupsLeftOut, 2);
    assert.ok(!paths.includes('local/backups/2026-10-01T000000Z/manifest.json')); // the oldest stay on the machine
    assert.ok(p.skipped.some(s => s.path === 'local/feeds/token-cache.json')); // a suspicious name inside a data folder is reported, not copied
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the export mirrors into the target with a manifest, and a secret anywhere stops it before writing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'export-'));
  try {
    const to = join(root, 'data-repo');
    await put(root, '.local/digests/2026-10-20.md', '# Digest');
    await put(root, 'integrations/hermes/.state/run.json', '{}');
    await put(to, 'local/digests/old-file.md', 'stale');
    const r = await write(root, to, { commit: 'abc123', now: new Date('2026-10-21T12:00:00Z') });
    assert.equal(r.written, true);
    assert.equal(await readFile(join(to, 'local', 'digests', '2026-10-20.md'), 'utf8'), '# Digest');
    assert.equal(existsSync(join(to, 'state', 'hermes', 'run.json')), true);
    assert.equal(existsSync(join(to, 'local', 'digests', 'old-file.md')), false); // removed locally, removed in the copy
    const manifest = JSON.parse(await readFile(join(to, 'MANIFEST.json'), 'utf8'));
    assert.deepEqual([manifest.codeCommit, manifest.files, manifest.list[0].path, manifest.list[0].sha256.length], ['abc123', 2, 'local/digests/2026-10-20.md', 64]);
    assert.ok(!JSON.stringify(manifest).includes(root.replace(/\\/g, '\\\\'))); // no machine paths in the manifest
    assert.match(await readFile(join(to, 'README.md'), 'utf8'), /Keep this repository private/);
    // a credential inside an allowed file: nothing is written, and the finding names the rule, never the secret
    const fake = ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' '); // assembled, so this file holds no key header
    await put(root, '.local/cycles/2026-10-21.json', JSON.stringify({ note: fake }));
    const refused = await write(root, to);
    assert.equal(refused.written, false);
    assert.ok(refused.findings.length >= 1 && refused.findings[0].path === 'local/cycles/2026-10-21.json');
    assert.ok(!JSON.stringify(refused.findings).includes(fake));
    assert.equal(existsSync(join(to, 'local', 'digests', '2026-10-20.md')), true); // the previous good export is untouched
  } finally { await rm(root, { recursive: true, force: true }); }
});
