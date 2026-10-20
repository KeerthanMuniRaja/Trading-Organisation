import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnose, loadPlaybook } from './playbook.mjs';
import { runCycle } from './organisation-cycle.mjs';

test('every playbook entry says the cause, the fix and who decides; the last one catches anything', () => {
  const list = loadPlaybook();
  assert.ok(list.length >= 10);
  for (const p of list) assert.ok(p.cause && p.fix && ['agents', 'owner'].includes(p.decidedBy), p.id);
  assert.equal(list.at(-1).id, 'unknown');
});

test('a failure is matched to the known problem by step and text', () => {
  assert.equal(diagnose('market-data', 'large move kept back, check the news: SBIN.NS 27.7% on 2017-10-25').id, 'data-kept-back');
  assert.equal(diagnose('market-data', 'possible split or bonus, record it').id, 'corporate-action');
  assert.equal(diagnose('market-data', 'exit 1').decidedBy, 'agents'); // a network failure retries by itself
  assert.equal(diagnose('news-economictimes', 'feed fetch-failed').id, 'feed-failing');
  assert.equal(diagnose('rule-bot', 'release gate: code fingerprint differs').id, 'release-gate');
  assert.equal(diagnose('debate', '[timed out]').id, 'timeout');
  assert.equal(diagnose('something-new', 'odd').id, 'unknown');
});

test('the cycle writes the matching fix into the journal of a failed step', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'playbook-'));
  try {
    const journalPath = join(dir, 'cycle.json');
    const steps = [{ id: 'market-data', cmd: 'x', verify: () => ({ status: 'degraded', note: 'previous data kept for SBIN.NS' }) },
      { id: 'news-wire', cmd: 'x' }];
    const run = async step => step.id === 'news-wire' ? { code: 1, tail: 'feed fetch-failed' } : { code: 0, output: '', tail: '' };
    const results = await runCycle({ steps, journalPath, run, sleep: async () => {}, escalateStep: async () => 'none' });
    assert.equal(results[0].playbook.id, 'data-kept-back');
    assert.equal(results[1].playbook.id, 'feed-failing');
    const journal = JSON.parse(await readFile(journalPath, 'utf8'));
    assert.equal(journal.steps['news-wire'].playbook.decidedBy, 'owner');
    // a failure nobody knows is kept for the playbook
    await runCycle({ steps: [{ id: 'brand-new-step', cmd: 'x' }], journalPath, run: async () => ({ code: 3, tail: 'strange error' }),
      sleep: async () => {}, escalateStep: async () => 'none' });
    const unknown = (await readFile(join(dir, 'unknown-problems.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual([unknown.length, unknown[0].step, unknown[0].text], [1, 'brand-new-step', 'strange error']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
