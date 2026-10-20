import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan } from './prune-env-backups.mjs';

test('only older .env copies are planned for deletion; the newest and every other file stay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'envb-'));
  try {
    for (const [i, name] of ['.env.a', '.env.b', '.env.c', '.env.d'].entries()) {
      await writeFile(join(dir, name), 'x');
      await utimes(join(dir, name), 1_700_000_000 + i, 1_700_000_000 + i); // .env.d is the newest
    }
    await writeFile(join(dir, 'notes.txt'), 'keep');
    await mkdir(join(dir, '.env.folder'));
    assert.deepEqual((await plan(dir, 2)).map(d => d.name), ['.env.b', '.env.a']);
    assert.deepEqual(await plan(dir, 10), []);
    assert.deepEqual(await plan(join(dir, 'missing'), 3), []);
    await assert.rejects(() => plan(dir, 0), /at least 1/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
