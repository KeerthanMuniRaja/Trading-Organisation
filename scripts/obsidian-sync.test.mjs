import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncVault } from './obsidian-sync.mjs';
test('vault export is selective, repeatable, and preserves user edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-obsidian-'));
  const project = join(root, 'project'), vault = join(root, 'vault');
  for (const p of [join(project, 'docs'), join(project, 'integrations'), join(vault, '.obsidian')]) await mkdir(p, { recursive: true });
  await writeFile(join(project, 'docs', 'guide.md'), '# Guide\n');
  await writeFile(join(project, '.env'), 'SECRET=must-not-export');
  await writeFile(join(vault, '.obsidian', 'app.json'), '{"existing":true}');
  const first = await syncVault(project, vault);
  assert.equal(first.conflicts.length, 0);
  assert.equal((await syncVault(project, vault)).conflicts.length, 0);
  assert.equal(await readFile(join(vault, '.obsidian', 'app.json'), 'utf8'), '{"existing":true}');
  const note = join(vault, 'Nexus', 'Library', 'docs', 'guide.md');
  await writeFile(note, '# My edit');
  await writeFile(join(project, 'docs', 'guide.md'), '# New source');
  assert.deepEqual((await syncVault(project, vault)).conflicts, ['Library/docs/guide.md']);
  assert.equal(await readFile(note, 'utf8'), '# My edit');
  assert.deepEqual(await readdir(join(vault, 'Nexus', 'Library')), ['docs']);
});
test('parent folder is not silently turned into a vault', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-not-vault-'));
  await assert.rejects(syncVault(directory, directory));
  assert.deepEqual(await readdir(directory), []);
});
