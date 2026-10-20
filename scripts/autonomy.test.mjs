import test from 'node:test';
import assert from 'node:assert/strict';
import { set, show } from './autonomy.mjs';

const ENV = { PRINCIPALS_JSON: JSON.stringify([{ role: 'owner', token: 'o' }, { role: 'evaluator', token: 'e' }]) };

test('the owner sets and reads the standing approvals with the owner credential only', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push([new URL(url).pathname, init.method ?? 'GET', init.headers.Authorization, init.body ? JSON.parse(init.body) : null]);
    return { ok: true, status: 200, text: async () => '{"ok":true}' }; };
  await set(ENV, { suspendOnRecommendation: true }, 'Stop losing bots', fetchImpl);
  await show(ENV, fetchImpl);
  assert.deepEqual(calls.map(c => c.slice(0, 3)), [['/v1/autonomy/policy', 'POST', 'Bearer o'], ['/v1/autonomy', 'GET', 'Bearer o']]);
  assert.deepEqual(calls[0][3], { rules: { suspendOnRecommendation: true }, reason: 'Stop losing bots' });
  await assert.rejects(() => set(ENV, {}, '', fetchImpl), /Say why/);
  await assert.rejects(() => show({ PRINCIPALS_JSON: '[]' }, fetchImpl), /exactly one owner/);
});
