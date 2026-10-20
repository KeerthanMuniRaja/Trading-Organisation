import test from 'node:test';
import assert from 'node:assert/strict';
import { PER_ROLE, runLearning } from './learning-cycle.mjs';

const ENV = { PRINCIPALS_JSON: JSON.stringify([{ role: 'researcher', token: 'r' }, { role: 'evaluator', token: 'e' }, { role: 'owner', token: 'o' }]) };

test('every open workflow advances one stage for the role it waits on; reviews are reported, not skipped', async () => {
  const lists = {
    'Bearer r': [{ workflowId: 'w1', state: 'source', actionable: true }, { workflowId: 'w2', state: 'awaiting-source-review', actionable: false },
      { workflowId: 'w3', state: 'assessment-create', actionable: false }],
    'Bearer e': [{ workflowId: 'w3', state: 'assessment-create', actionable: true }, { workflowId: 'w2', state: 'awaiting-source-review', actionable: false }],
  };
  const asked = [], ran = [];
  const fetchImpl = async (url, init) => { asked.push(init.headers.Authorization); return { ok: true, text: async () => JSON.stringify({ workflows: lists[init.headers.Authorization] }) }; };
  const result = await runLearning(ENV, { fetchImpl, run: async args => { ran.push(args); return { code: 0, tail: 'ok' }; } });
  assert.deepEqual(asked, ['Bearer r', 'Bearer e']); // each role asks with its own credential, never the owner's
  assert.deepEqual(ran, [['workflow-run', '--workflow-id', 'w1', '--role', 'researcher'], ['workflow-run', '--workflow-id', 'w3', '--role', 'evaluator']]);
  assert.deepEqual(result.advanced.map(a => [a.workflowId, a.role]), [['w1', 'researcher'], ['w3', 'evaluator']]);
  assert.deepEqual(result.waiting, [{ workflowId: 'w2', state: 'awaiting-source-review' }]); // waiting on a review decision
  assert.deepEqual(result.failed, []);
});

test('model use is bounded per cycle and a failed stage is reported', async () => {
  const many = Array.from({ length: PER_ROLE + 3 }, (_, i) => ({ workflowId: 'w' + i, state: 'source', actionable: true }));
  const fetchImpl = async (url, init) => ({ ok: true, text: async () => JSON.stringify({ workflows: init.headers.Authorization === 'Bearer r' ? many : [] }) });
  let calls = 0;
  const result = await runLearning(ENV, { fetchImpl, run: async () => (++calls === 2 ? { code: 1, tail: 'model unavailable' } : { code: 0 }) });
  assert.equal(calls, PER_ROLE);
  assert.deepEqual(result.failed.map(f => [f.workflowId, f.reason]), [['w1', 'model unavailable']]);
  await assert.rejects(() => runLearning({ PRINCIPALS_JSON: '[]' }, { fetchImpl }), /exactly one researcher/);
});
