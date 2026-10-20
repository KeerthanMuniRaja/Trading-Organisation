import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Database } from '../src/database.js';

test('an applied migration may change line endings but never content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'migrations-')), home = process.cwd();
  try {
    await cp(resolve('db/migrations'), join(dir, 'db/migrations'), { recursive: true });
    process.chdir(dir);
    const first = join('db/migrations', '001_initial.sql'), original = (await readFile(first, 'utf8')).replace(/\r\n/g, '\n');
    await writeFile(first, original);
    await (await Database.open(join(dir, 'data'))).close(); // applies everything

    await writeFile(first, original.replace(/\n/g, '\r\n')); // a Windows checkout rewrote the line endings
    await (await Database.open(join(dir, 'data'))).close();

    await writeFile(first, original + '\n-- an edit after the fact\n');
    await assert.rejects(() => Database.open(join(dir, 'data')), /Migration checksum mismatch/);
  } finally { process.chdir(home); await rm(dir, { recursive: true, force: true }); }
});
