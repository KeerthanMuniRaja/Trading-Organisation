import test from 'node:test';
import assert from 'node:assert/strict';
import { renew } from './release-renewal.mjs';

const ENV = { RULE_BOT_ID: 'momentum-rules', PRINCIPALS_JSON: JSON.stringify([{ role: 'owner', token: 'o' }, { role: 'researcher', token: 'r' },
  { role: 'evaluator', token: 'e' }, { role: 'trader', token: 't', botId: 'momentum-rules' }]) };
const ID = { model: 'rules:top3-momentum-6m', promptVersion: 'rule-v1', codeFingerprint: 'f'.repeat(64) };
const STUDY = { from: '2022-08', through: '2026-09', byRule: { 'top3-momentum-6m': { 'all months': { months: 50, ahead: 32, behind: 18 } } } };

function backend(check) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname, body = init.body ? JSON.parse(init.body) : null;
    calls.push([path, init.headers.Authorization, body]);
    const reply = path === '/v1/releases/check' ? check : path === '/v1/bots/fitness' ? { id: 'fit', verdict: 'adds-value' }
      : path === '/v1/releases' ? { id: 'rel-2', version: 2 } : { id: 'ev', canaryEligible: true, activeEligible: true };
    return { ok: true, status: 201, text: async () => JSON.stringify(reply) };
  };
  return { calls, fetchImpl };
}

test('a code change under the same rule is prepared as a new release by the agents, never staged here', async () => {
  const { calls, fetchImpl } = backend({ allowed: false, reason: 'version-not-authorised', authorised: { version: 1, model: ID.model, promptVersion: ID.promptVersion } });
  const out = await renew(ENV, { fetchImpl, id: ID, study: STUDY });
  assert.deepEqual([out.state, out.releaseVersion, out.canaryEligible], ['prepared', 2, true]);
  assert.deepEqual(calls.map(c => [c[0], c[1]]), [['/v1/releases/check', 'Bearer e'], ['/v1/bots/fitness', 'Bearer e'], ['/v1/releases', 'Bearer r'],
    ['/v1/releases/evaluations', 'Bearer e']]); // researcher registers, evaluator judges, never the owner credential
  assert.ok(!calls.some(c => c[0].includes('stages')));
});

test('a current release, a changed rule or a missing study is left alone', async () => {
  assert.equal((await renew(ENV, { ...backend({ allowed: true, version: 2, stage: 'active' }), id: ID, study: STUDY })).state, 'current');
  const changed = await renew(ENV, { ...backend({ allowed: false, reason: 'version-not-authorised', authorised: { version: 1, model: ID.model, promptVersion: 'old-rule' } }), id: ID, study: STUDY });
  assert.match(changed.reason, /new idea, not a code fix/);
  const { calls, fetchImpl } = backend({ allowed: false, reason: 'version-not-authorised', authorised: { version: 1, model: ID.model, promptVersion: ID.promptVersion } });
  assert.equal((await renew(ENV, { fetchImpl, id: ID, study: null })).state, 'not-renewed');
  assert.equal(calls.length, 1);
  assert.equal((await renew({ ...ENV, RULE_BOT_ID: '' }, { ...backend({}), id: ID, study: STUDY })).state, 'skipped');
});
