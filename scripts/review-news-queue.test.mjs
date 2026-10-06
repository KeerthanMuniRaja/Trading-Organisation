import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchReviewQueue } from './review-news-queue.mjs';
const env = { API_URL: 'http://127.0.0.1:3000', PRINCIPALS_JSON: JSON.stringify([
  { role: 'researcher', token: 'research-only' }, { role: 'evaluator', token: 'evaluation-only' },
]) };
test('queue reader uses only evaluator credentials and the read endpoint', async () => {
  const value = { scope: 'pending-source-observations', observations: [], nextCursor: null };
  let calls = 0;
  assert.deepEqual(await fetchReviewQueue({ limit: 10 }, env, async (url, options) => {
    calls++;
    assert.equal(url.pathname, '/v1/sources/observations/review-queue');
    assert.equal(options.headers.Authorization, 'Bearer evaluation-only');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body), { limit: 10 });
    return Response.json(value);
  }), value);
  assert.equal(calls, 1);
});
test('invalid endpoint, credentials or query cannot send a request', async () => {
  let calls = 0; const transport = async () => { calls++; };
  await assert.rejects(() => fetchReviewQueue({}, { ...env, API_URL: 'http://remote.example' }, transport));
  await assert.rejects(() => fetchReviewQueue({}, { ...env, PRINCIPALS_JSON: '[]' }, transport));
  await assert.rejects(() => fetchReviewQueue({ status: 'verified' }, env, transport));
  assert.equal(calls, 0);
});
test('malformed, failed and oversized responses are rejected', async () => {
  for (const response of [new Response('private error', { status: 500 }), Response.json({}), new Response('x'.repeat(300001))])
    await assert.rejects(() => fetchReviewQueue({}, env, async () => response));
});
