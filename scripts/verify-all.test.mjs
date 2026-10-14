import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { count, suites, verify } from './verify-all.mjs';

test('one gate: every suite runs, logs are kept, and any failure fails the whole gate', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'verify-'));
  try {
    const seen = [];
    const ok = await verify({ logDir: dir, runner: async s => { seen.push(s.id); return { code: 0, output: s.id === 'trading-desk' ? 'Ran 106 tests in 30s\n\nOK' : 'ℹ tests 5\nℹ pass 5' }; } });
    assert.equal(ok.passed, true);
    assert.ok(seen.includes('backend-tests') && seen.includes('secret-scan'));
    const desk = ok.results.find(r => r.id === 'trading-desk');
    if (desk.status !== 'skipped') assert.equal(desk.tests, '106 ran'); // skipped only where the Python environment is not installed
    assert.match(await readFile(join(dir, 'secret-scan.log'), 'utf8'), /tests 5/);

    const failing = await verify({ logDir: dir, quick: true, runner: async s => ({ code: s.id === 'script-tests' ? 1 : 0, output: '' }) });
    assert.equal(failing.passed, false);
    assert.ok(!failing.results.some(r => r.id === 'backend-tests')); // --quick skips the long backend suite

    const noBuild = await verify({ logDir: dir, runner: async s => ({ code: s.id === 'backend-build' ? 2 : 0, output: '' }) });
    assert.deepEqual(noBuild.results.map(r => r.id), ['secret-scan', 'backend-build']); // nothing runs on a broken build
    assert.equal(noBuild.passed, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('test counts are read from both runners', () => {
  assert.equal(count('ℹ tests 162\nℹ suites 0\nℹ pass 162\nℹ fail 0'), '162/162');
  assert.equal(count('.....\nRan 106 tests in 38.1s\nOK'), '106 ran');
  assert.equal(count('nothing'), null);
  assert.ok(suites().some(s => s.id === 'claims'));
  // every test file in the repository belongs to some suite
  for (const id of ['integration-tests', 'hermes', 'market-replay', 'skfolio']) assert.ok(suites().some(s => s.id === id), id);
});
