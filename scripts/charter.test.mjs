import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parts, set } from './charter.mjs';

const env = { PRINCIPALS_JSON: JSON.stringify([{ id: 'o', role: 'owner', token: 'owner-token' }]) };

test('the charter sets the brakes first, then the standing approvals, with one reason', async () => {
  const charter = JSON.parse(await readFile(new URL('../docs/policies/founder-charter.json', import.meta.url), 'utf8'));
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return { ok: true, text: async () => '{"policyId":"p"}' }; };
  await set(env, charter, 'I leave it to run', fetchImpl);
  assert.deepEqual(sent.map(s => s.url.replace('http://127.0.0.1:3000', '')), ['/v1/protections/policy', '/v1/autonomy/policy']);
  assert.equal(sent[0].body.rules.organisationLossPaise, '150000');                 // the last-resort stop is part of it
  assert.equal(sent[1].body.rules.reduceBudget, true);                               // budget follows evidence both ways
  assert.ok(sent.every(s => s.body.reason === 'Founder charter: I leave it to run'));
  await assert.rejects(() => set(env, charter, ' ', fetchImpl), /Say why/);
  assert.throws(() => parts({ autonomy: {} }), /two parts/);
});
