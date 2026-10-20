import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from './live-fitness.mjs';

const ENV = { PRINCIPALS_JSON: JSON.stringify([{ id: 'e', role: 'evaluator', token: 'eval-token' }]) };

function backend(reports) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname, body = init.body ? JSON.parse(init.body) : null;
    calls.push([path, body, init.headers['Idempotency-Key'] ?? null]);
    const reply = (status, json) => ({ status, ok: status < 300, text: async () => JSON.stringify(json) });
    if (path === '/v1/bots') return reply(200, [{ id: 'rules', state: 'paper' }, { id: 'quiet', state: 'paper' }, { id: 'early', state: 'paper' }, { id: 'old', state: 'retired' }]);
    if (path === '/v1/releases/view') return reply(201, { active: body.botId === 'quiet' ? null : 'rel-' + body.botId });
    if (path === '/v1/bots/fitness/live') return reports[body.botId] ? reply(201, reports[body.botId]) : reply(409, { message: 'No scored live paper calls yet' });
    if (path === '/v1/releases/evaluations') return reply(201, { activeEligible: false });
    return reply(404, {});
  };
  return { calls, fetchImpl };
}

test('every bot with scored calls gets a live report; only a real verdict re-evaluates its active release', async () => {
  const { calls, fetchImpl } = backend({ rules: { id: 'r1', verdict: 'worse-than-baseline', pValue: 0.011 }, early: { id: 'r2', verdict: 'insufficient-evidence', duplicate: true } });
  const results = await run(ENV, { fetchImpl, now: new Date('2026-11-20T12:00:00Z') });
  assert.deepEqual(results, [
    { botId: 'rules', releaseId: 'rel-rules', verdict: 'worse-than-baseline', pValue: 0.011, newReport: true, evaluation: { activeEligible: false } },
    { botId: 'early', releaseId: 'rel-early', verdict: 'insufficient-evidence', pValue: null, newReport: false }]); // 'quiet' has no calls, 'old' is retired
  const evaluations = calls.filter(([path]) => path === '/v1/releases/evaluations');
  assert.deepEqual(evaluations.map(([, body]) => body), [{ releaseId: 'rel-rules', fitnessReportId: 'r1' }]);
  assert.ok(calls.filter(([path]) => path === '/v1/bots/fitness/live').every(([, , k]) => /^livefit-[a-f0-9]{48}$/.test(k)));
  assert.ok(!calls.some(([path]) => path.includes('stages') || path.includes('rollbacks'))); // never rolls anything back
});

test('a canary is judged on its own live calls and re-evaluated with them', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname, body = init.body ? JSON.parse(init.body) : null;
    calls.push([path, body]);
    const reply = (status, json) => ({ status, ok: status < 300, text: async () => JSON.stringify(json) });
    if (path === '/v1/bots') return reply(200, [{ id: 'alloc', state: 'paper' }]);
    if (path === '/v1/releases/view') return reply(201, { active: 'v1', canary: 'v2' });
    if (path === '/v1/bots/fitness/live') return reply(201, body.releaseId === 'v2' ? { id: 'c1', verdict: 'adds-value', pValue: 0.01 } : { id: 'a1', verdict: 'no-detectable-skill', pValue: 0.4 });
    if (path === '/v1/releases/evaluations') return reply(201, { activeEligible: true });
    return reply(404, {});
  };
  const results = await run(ENV, { fetchImpl, now: new Date('2026-11-20T12:00:00Z') });
  assert.deepEqual(results.map(r => [r.releaseId, r.stage ?? 'active', r.verdict]), [['v1', 'active', 'no-detectable-skill'], ['v2', 'canary', 'adds-value']]);
  assert.deepEqual(calls.filter(([p]) => p === '/v1/releases/evaluations').map(([, b]) => b), [{ releaseId: 'v1', fitnessReportId: 'a1' }, { releaseId: 'v2', fitnessReportId: 'c1' }]);
  assert.ok(!calls.some(([path]) => path.includes('stages') || path.includes('rollbacks'))); // promotion is the autonomy step's job, not this one
});

test('the daily key changes each day, so a new day files a new report when the numbers changed', async () => {
  const keys = [];
  for (const day of ['2026-11-20', '2026-11-21']) {
    const { calls, fetchImpl } = backend({ rules: { id: 'r1', verdict: 'no-detectable-skill' } });
    await run(ENV, { fetchImpl, now: new Date(day + 'T12:00:00Z') });
    keys.push(calls.find(([path]) => path === '/v1/bots/fitness/live')[2]);
  }
  assert.notEqual(keys[0], keys[1]);
});
