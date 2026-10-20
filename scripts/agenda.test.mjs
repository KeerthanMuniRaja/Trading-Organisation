import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, describe, find } from './agenda.mjs';

const ENV = { API_URL: 'http://127.0.0.1:3000', PRINCIPALS_JSON: JSON.stringify([{ role: 'owner', token: 'o' }, { role: 'evaluator', token: 'e' }]) };
const ITEMS = [
  { type: 'recommendation', id: '11111111-aaaa-4000-8000-000000000001', botId: 'bot-one', kind: 'suspend', reason: 'Loses to cash' },
  { type: 'recommendation', id: '22222222-aaaa-4000-8000-000000000002', botId: 'old-bot', kind: 'retire', reason: 'Still worse' },
  { type: 'birth', id: '33333333-aaaa-4000-8000-000000000003', botId: 'mean-revert', department: 'rnd', specialty: 'reversal', opportunity: 'Rebounds' },
  { type: 'department', id: '44444444-aaaa-4000-8000-000000000004', kind: 'open', departmentId: 'rnd', rationale: 'Research' },
  { type: 'release', id: '55555555-aaaa-4000-8000-000000000005', botId: 'cand', version: 2, model: 'rules', fitnessVerdict: 'adds-value' },
  { type: 'qualification', id: 'candidate-bot', botId: 'candidate-bot' },
];

function backend() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname, body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, path, body, key: init.headers['Idempotency-Key'], auth: init.headers.Authorization });
    const reply = path === '/v1/organisation/agenda' ? { items: ITEMS }
      : path === '/v1/knowledge' ? { lessons: [{ id: 'l1', bot_id: 'old-bot' }, { id: 'l2', bot_id: 'someone-else' }] } : { ok: true };
    return { ok: true, status: 200, text: async () => JSON.stringify(reply) };
  };
  return { calls, fetchImpl };
}

test('each kind of decision goes to its own owner route, with a stable idempotency key', async () => {
  const cases = [
    ['11111111', true, '/v1/management/decisions', { recommendationId: ITEMS[0].id, outcome: 'accepted' }],
    ['33333333', false, '/v1/bots/births/decisions', { proposalId: ITEMS[2].id, outcome: 'rejected' }],
    ['55555555', true, '/v1/releases/stages', { releaseId: ITEMS[4].id, stage: 'active' }],
    ['candidate-bot', true, '/v1/releases/qualifications', { botId: 'candidate-bot' }],
  ];
  for (const [id, accept, path, expected] of cases) {
    const { calls, fetchImpl } = backend();
    await decide(ENV, { id, accept, fetchImpl });
    const post = calls.find(c => c.method === 'POST');
    assert.equal(post.path, path);
    for (const [k, v] of Object.entries(expected)) assert.equal(post.body[k], v);
    assert.equal(post.auth, 'Bearer o'); // the owner's credential only
    const again = backend();
    await decide(ENV, { id, accept, fetchImpl: again.fetchImpl });
    assert.equal(again.calls.find(c => c.method === 'POST').key, post.key); // a rerun replays, never repeats
  }
});

test('retiring hands on the bot\'s own lessons first; a department needs its budget; ids must be unambiguous', async () => {
  const { calls, fetchImpl } = backend();
  await decide(ENV, { id: '22222222', accept: true, fetchImpl });
  const posts = calls.filter(c => c.method === 'POST');
  assert.deepEqual(posts.map(p => p.path), ['/v1/bots/retirements', '/v1/management/decisions']);
  assert.deepEqual(posts[0].body.transferLessonIds, ['l1']);
  await assert.rejects(() => decide(ENV, { id: '44444444', accept: true, fetchImpl }), /budget ceiling/);
  const opened = backend();
  await decide(ENV, { id: '44444444', accept: true, budgetPaise: '1000000', fetchImpl: opened.fetchImpl });
  assert.equal(opened.calls.find(c => c.method === 'POST').body.budgetPaise, '1000000');
  assert.throws(() => find(ITEMS, '1111'), /at least its first 8/);
  assert.throws(() => find(ITEMS, '99999999'), /Nothing waiting/);
  assert.match(describe(ITEMS[0]), /^11111111  recommendation +bot-one: suspend — Loses to cash$/);
  const { fetchImpl: noOwner } = backend();
  await assert.rejects(() => decide({ ...ENV, PRINCIPALS_JSON: '[]' }, { id: '11111111', accept: true, fetchImpl: noOwner }), /exactly one owner/);
});
