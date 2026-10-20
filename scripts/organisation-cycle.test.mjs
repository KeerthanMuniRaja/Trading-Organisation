import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planSteps, runCycle, runHttp, escalate, releaseCheck, computeCheck, verifyMarketData, verifyFeed, ESCALATE_AFTER } from './organisation-cycle.mjs';

const steps = [
  { id: 'backend-health', critical: true, kind: 'http', path: '/v1/health' },
  { id: 'market-data', cmd: 'x' },
  { id: 'claims-and-fact-check', skip: 'model steps not enabled (--with-model)' },
  { id: 'chain-links', cmd: 'x', requires: join(tmpdir(), 'does-not-exist-' + Date.now()) },
  { id: 'alerts', cmd: 'x' },
];

test('a cycle runs each step once a day, resumes after failures and skips what it cannot do', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cycle-'));
  try {
    const journalPath = join(dir, 'day.json');
    const calls = [];
    let alertsFail = true;
    const run = async step => { calls.push(step.id); return { code: step.id === 'alerts' && alertsFail ? 1 : 0, tail: 'ok' }; };
    const http = async () => ({ code: 0, tail: 'HTTP 200' });
    const first = await runCycle({ steps, journalPath, run, http });
    assert.deepEqual(first.map(r => [r.id, r.status]), [['backend-health', 'done'], ['market-data', 'done'], ['claims-and-fact-check', 'skipped'],
      ['chain-links', 'skipped'], ['alerts', 'failed']]);
    alertsFail = false;
    const second = await runCycle({ steps, journalPath, run, http });
    assert.deepEqual(calls, ['market-data', 'alerts', 'alerts']); // market data was not fetched twice; only the failed step reran
    assert.equal(second.find(r => r.id === 'market-data').resumed, true);
    assert.equal(second.find(r => r.id === 'alerts').status, 'done');
    const journal = JSON.parse(await readFile(journalPath, 'utf8'));
    assert.equal(journal.steps.alerts.attempts, 2);
    await runCycle({ steps, journalPath, run, http, force: true });
    assert.equal(calls.filter(c => c === 'market-data').length, 2); // --force reruns everything
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('runbooks: transient failures retry with back-off; postconditions can degrade or fail a "successful" run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cycle-'));
  try {
    let calls = 0;
    const slept = [];
    const flaky = { id: 'market-data', cmd: 'x', retries: 2, verify: verifyMarketData };
    const results = await runCycle({ steps: [flaky], journalPath: join(dir, 'd.json'), sleep: async ms => { slept.push(ms); },
      run: async () => (++calls < 3 ? { code: 1, tail: 'network' } : { code: 0, output: '[{"symbol":"INFY.NS","state":"downloaded"}]' }) });
    assert.deepEqual([results[0].status, results[0].tries, slept], ['done', 3, [30000, 90000]]);

    assert.deepEqual(verifyMarketData('noise\n[{"symbol":"A","state":"downloaded"},{"symbol":"B","state":"kept-previous","issues":[{"check":"extreme-move","date":"2026-10-15","changePct":-25}]}]'),
      { status: 'degraded', note: 'previous data kept for B; large move kept back, check the news: B -25% on 2026-10-15 (if real: daily.py accept-move --symbol B --date 2026-10-15)' });
    assert.deepEqual(verifyMarketData('[{"symbol":"HDFCBANK.NS","state":"downloaded","warnings":[{"check":"corporate-action-suspected","factor":2,"likelyExDate":"2026-11-03"}]}]'),
      { status: 'degraded', note: 'possible split or bonus, record it in /v1/corporate-actions: HDFCBANK x2 from 2026-11-03' });
    assert.equal(verifyMarketData('[{"symbol":"A","state":"downloaded","warnings":[{"check":"gaps"}]}]').status, 'done');
    assert.equal(verifyMarketData('Traceback ...').status, 'failed');
    assert.equal(verifyFeed('> npm\n{"state":"fetch-failed","code":"FEED_TIMEOUT","evidenceIds":["a","b"]}').status, 'failed');
    assert.equal(verifyFeed('{"state":"awaiting-review","submitted":3,"evidenceIds":["a"],"rejected":[{"index":1}]}').status, 'done');
    assert.equal(verifyFeed('{"state":"backoff","consecutiveFailures":2}').status, 'failed'); // an outage must reach escalation
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a step failing several cycles in a row is escalated once, as a warning, and the streak resets on success', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cycle-'));
  try {
    const escalations = [];
    let ok = false;
    const steps = [{ id: 'news-wire', cmd: 'x' }];
    const cycle = day => runCycle({ steps, journalPath: join(dir, `${day}.json`), run: async () => ({ code: ok ? 0 : 1, tail: 'FEED_UNREACHABLE' }),
      escalateStep: async (step, streak) => { escalations.push([step.id, streak]); return 'incident'; } });
    for (let day = 1; day <= ESCALATE_AFTER + 1; day++) await cycle(day); // fails every day
    assert.deepEqual(escalations, [['news-wire', ESCALATE_AFTER]]); // exactly once, not every day after
    ok = true; await cycle(9);
    ok = false; for (let day = 10; day < 10 + ESCALATE_AFTER; day++) await cycle(day);
    assert.equal(escalations.length, 2); // a fresh streak after recovery escalates again

    const sent = [];
    const env = { PRINCIPALS_JSON: JSON.stringify([{ id: 'e', role: 'evaluator', token: 'eval-token' }]), ALERT_OUTBOX: join(dir, 'outbox.jsonl') };
    assert.equal(await escalate({ id: 'news-wire' }, 3, 'timeout', env, async (url, init) => { sent.push(JSON.parse(init.body)); return { ok: true }; }), 'incident');
    assert.deepEqual(sent[0].severity, 'warning'); // never 'critical', which would halt new risk
    assert.equal(await escalate({ id: 'news-wire' }, 3, 'timeout', env, async () => { throw new Error('down'); }), 'outbox');
    assert.match(await readFile(join(dir, 'outbox.jsonl'), 'utf8'), /cycle-escalation/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a release-controlled bot runs only while its exact code is the authorised release', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cycle-'));
  try {
    const ran = [];
    const bot = { id: 'rule-bot', cmd: 'x', releaseGate: { botId: 'momentum-rules', cmd: 'py', args: ['rule_bot.py', '--describe'] } };
    const blocked = await runCycle({ steps: [bot], journalPath: join(dir, 'a.json'), run: async s => { ran.push(s.id); return { code: 0 }; },
      gate: async () => 'its code or rule differs from the authorised release v1: register, evaluate and activate a new release before it trades' });
    assert.deepEqual([blocked[0].status, ran], ['failed', []]); // refused before it could propose anything
    assert.match(blocked[0].reason, /^release gate: its code or rule differs/);
    const allowed = await runCycle({ steps: [bot], journalPath: join(dir, 'b.json'), run: async s => { ran.push(s.id); return { code: 0 }; }, gate: async () => null });
    assert.deepEqual([allowed[0].status, ran], ['done', ['rule-bot']]);

    // the check itself: identity from the bot's own --describe, answer from the backend's release check, evaluator credential only
    const env = { PRINCIPALS_JSON: JSON.stringify([{ role: 'owner', token: 'o' }, { role: 'evaluator', token: 'e' }]) };
    const describe = async () => ({ code: 0, output: 'noise\n{"model":"rules:top3","promptVersion":"abc","codeFingerprint":"f00d","rule":"x"}' });
    const sent = [];
    const answer = reply => async (url, init) => { sent.push([url, init.headers.Authorization, JSON.parse(init.body)]); return { ok: true, status: 201, text: async () => JSON.stringify(reply) }; };
    assert.equal(await releaseCheck(bot.releaseGate, { run: describe, env, fetchImpl: answer({ allowed: true, version: 1 }) }), null);
    assert.deepEqual(sent[0], ['http://127.0.0.1:3000/v1/releases/check', 'Bearer e', { botId: 'momentum-rules', model: 'rules:top3', promptVersion: 'abc', codeFingerprint: 'f00d' }]);
    assert.match(await releaseCheck(bot.releaseGate, { run: describe, env, fetchImpl: answer({ allowed: false, reason: 'version-not-authorised', authorised: { version: 1 } }) }),
      /differs from the authorised release v1/);
    assert.match(await releaseCheck(bot.releaseGate, { run: async () => ({ code: 1, output: '' }), env, fetchImpl: answer({ allowed: true }) }), /release identity/);
    assert.match(await releaseCheck(bot.releaseGate, { run: describe, env, fetchImpl: async () => { throw new Error('down'); } }), /unreachable/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a model step waits for tomorrow once its department used its compute budget', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cycle-'));
  try {
    const ran = [];
    const step = { id: 'model-allocator-decide', cmd: 'x', computeGate: { botId: 'allocator' } };
    const spent = await runCycle({ steps: [step], journalPath: join(dir, 'a.json'), run: async s => { ran.push(s.id); return { code: 0 }; },
      budget: async () => 'department portfolio used 50000 of its 50000 tokens today; it runs again tomorrow' });
    assert.deepEqual([spent[0].status, ran], ['skipped', []]);
    assert.match(spent[0].reason, /^compute budget: department portfolio/);
    assert.equal((await runCycle({ steps: [step], journalPath: join(dir, 'b.json'), run: async () => ({ code: 0 }), budget: async () => null }))[0].status, 'done');
    const env = { PRINCIPALS_JSON: JSON.stringify([{ role: 'evaluator', token: 'e' }]) };
    const answer = reply => async () => ({ ok: true, status: 200, text: async () => JSON.stringify(reply) });
    assert.equal(await computeCheck({ botId: 'a' }, { env, fetchImpl: answer({ allowed: true }) }), null);
    assert.match(await computeCheck({ botId: 'a' }, { env, fetchImpl: answer({ allowed: false, departmentId: 'p', usedTodayTokens: '9', budgetTokensPerDay: 5 }) }), /used 9 of its 5/);
    assert.match(await computeCheck({ botId: 'a' }, { env, fetchImpl: async () => { throw new Error('down'); } }), /unreachable/); // never spend on missing facts
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a failed health check stops the cycle before any other step', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cycle-'));
  try {
    const calls = [];
    const results = await runCycle({ steps, journalPath: join(dir, 'd.json'), run: async s => { calls.push(s.id); return { code: 0 }; },
      http: async () => ({ code: 1, tail: 'unreachable' }) });
    assert.deepEqual(results.map(r => r.status), ['failed', 'stopped']);
    assert.deepEqual(calls, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the plan finds feed configs, keeps model steps off by default, and HTTP steps use only the named role', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cycle-'));
  try {
    await mkdir(join(dir, '.local'), { recursive: true });
    await writeFile(join(dir, '.local', 'feed-wire.json'), '{"enabled":true}');
    await writeFile(join(dir, '.local', 'feed-fixture.json'), '{"enabled":false}');
    await writeFile(join(dir, '.local', 'feed-broken.json'), 'not json');
    const plan = await planSteps({ root: dir });
    assert.deepEqual(plan.filter(s => s.id.startsWith('news-')).map(s => s.id), ['news-wire', 'news-triage']); // only enabled feeds, then triage
    assert.equal(plan.find(s => s.id === 'claims-and-fact-check').skip, 'model steps not enabled (--with-model)');
    assert.ok((await planSteps({ root: dir, withModel: true })).find(s => s.id === 'claims-and-fact-check').cmd);
    // the academy and lifecycle cycles run daily, each with only its own role (they answer 'disabled' until enabled)
    const academy = plan.filter(s => ['academy-exams', 'lifecycle', 'research-dispatch', 'memory-research', 'memory-review'].includes(s.id));
    assert.deepEqual(academy.map(s => [s.id, s.role]), [['academy-exams', 'evaluator'], ['lifecycle', 'evaluator'], ['research-dispatch', 'evaluator'],
      ['memory-research', 'researcher'], ['memory-review', 'evaluator']]);
    assert.ok(plan.findIndex(s => s.id === 'lifecycle') < plan.findIndex(s => s.id === 'eod-trading'));
    const seen = [];
    const env = { PRINCIPALS_JSON: JSON.stringify([{ id: 'o', role: 'owner', token: 'owner-secret' }, { id: 'e', role: 'evaluator', token: 'eval-secret' }]) };
    await runHttp({ id: 'paper-snapshot', kind: 'http', method: 'POST', path: '/v1/paper/performance/snapshots', role: 'evaluator' }, env,
      async (url, init) => { seen.push(init.headers.Authorization); return { ok: true, status: 201, text: async () => '{}' }; });
    assert.deepEqual(seen, ['Bearer eval-secret']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
