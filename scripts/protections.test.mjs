import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { set, show } from './protections.mjs';

const env = { PRINCIPALS_JSON: JSON.stringify([{ id: 'o', role: 'owner', token: 'owner-token' }]) };

test('the owner sets protections with a reason and a stable key, and sees who is paused', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push({ url, init }); return { ok: true, text: async () => '{"policyId":"p","paused":[]}' }; };
  await set(env, { dailyLossPct: 2 }, 'Founder thresholds', fetchImpl);
  await set(env, { dailyLossPct: 2 }, 'Founder thresholds', fetchImpl);
  assert.equal(sent[0].url, 'http://127.0.0.1:3000/v1/protections/policy');
  assert.equal(sent[0].init.headers.Authorization, 'Bearer owner-token');
  assert.equal(sent[0].init.headers['Idempotency-Key'], sent[1].init.headers['Idempotency-Key']); // a repeat is a replay
  assert.deepEqual(JSON.parse(sent[0].init.body), { rules: { dailyLossPct: 2 }, reason: 'Founder thresholds' });
  await assert.rejects(() => set(env, {}, ' ', fetchImpl), /Say why/);
  await show(env, fetchImpl);
  assert.equal(sent.at(-1).url, 'http://127.0.0.1:3000/v1/protections/status');
  await assert.rejects(() => show({ PRINCIPALS_JSON: '[]' }, fetchImpl), /exactly one owner/);
  // the suggested file is a valid policy shape: thresholds the founder can accept or change
  const suggested = JSON.parse(await readFile(new URL('../docs/policies/protections-suggested.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(suggested.rules).sort(), ['dailyLossPct', 'losingExits', 'monthlyLossPct', 'shareCooldownDays', 'weeklyLossPct']);
});
