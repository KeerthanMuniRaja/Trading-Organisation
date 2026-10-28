import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decisionModel, planSteps, runCycle, runHttp, escalate, releaseCheck, computeCheck, taSteps, verifyMarketData, verifyFeed, ESCALATE_AFTER,
  runManifest, dataManifest, fingerprint, circuitOpen, CIRCUIT_AFTER, CIRCUIT_REST_MS } from './organisation-cycle.mjs';

test('TradingAgents decides only weekly with the model and its own environment; its member proposes every cycle', () => {
  const friday = Date.parse('2026-10-23T11:00:00Z'), tuesday = Date.parse('2026-10-20T11:00:00Z');
  const ids = s => s.map(x => [x.id, x.skip ? 'skip' : 'run']);
  assert.deepEqual(ids(taSteps({ withModel: true, root: '/r', desk: x => x, now: friday, env: {} })), [['tradingagents', 'skip']]);
  const env = { TA_BOT_ID: 'tradingagents' };
  assert.deepEqual(ids(taSteps({ withModel: true, root: '/r', desk: x => x, now: friday, env })), [['tradingagents-decide', 'run'], ['tradingagents-propose', 'run']]);
  const decide = taSteps({ withModel: true, root: '/r', desk: x => x, now: friday, env })[0];
  assert.deepEqual([decide.args.slice(-2), decide.computeGate.botId, /tradingagents-venv/.test(decide.requires)], [['--day', '2026-10-23'], 'tradingagents', true]);
  assert.match(taSteps({ withModel: true, root: '/r', desk: x => x, now: tuesday, env })[0].skip, /weekly/);
  assert.match(taSteps({ withModel: false, root: '/r', desk: x => x, now: friday, env })[0].skip, /model steps/);
});

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

test('every run keeps a manifest: the code and switches it started with and the prices it left', async () => {
  const root = await mkdtemp(join(tmpdir(), 'manifest-'));
  try {
    const put = async (path, text) => { await mkdir(join(root, ...path.slice(0, -1)), { recursive: true }); await writeFile(join(root, ...path), text); };
    await put(['scripts', 'a.mjs'], 'one\r\ntwo\r\n');
    await put(['integrations', 'desk', 'b.py'], 'x = 1\n');
    await put(['integrations', 'desk', '__pycache__', 'b.pyc.json'], 'ignored');
    await put(['.git', 'HEAD'], 'ref: refs/heads/dev\n');
    await put(['.git', 'refs', 'heads', 'dev'], '0123456789abcdef0123\n');
    await put(['.local', 'trading-desk', 'daily', 'A.NS-1d.json'], JSON.stringify({ symbol: 'A.NS', retrievedAt: 'r', bars: [{ date: '2026-10-13' }, { date: '2026-10-14' }] }));
    await put(['.local', 'trading-desk', 'daily', 'B.NS-1d.json'], JSON.stringify({ symbol: 'B.NS', bars: [{ date: '2026-10-12' }] }));
    const env = { RULE_BOT_ID: 'momentum-rules', PRINCIPALS_JSON: '[{"token":"secret"}]', HERMES_MODEL: 'qwen' };
    const m = await runManifest({ root, env, withModel: true, now: new Date('2026-10-14T12:00:00Z') });
    assert.deepEqual({ ...m, code: { ...m.code, fingerprint: typeof m.code.fingerprint } }, { startedAt: '2026-10-14T12:00:00.000Z', withModel: true, force: false,
      code: { commit: '0123456789ab', fingerprint: 'string', files: 2 }, switches: { RULE_BOT_ID: 'momentum-rules', HERMES_MODEL: 'qwen' } }); // never a credential
    // the same code gives the same fingerprint whatever the line ends
    await put(['scripts', 'a.mjs'], 'one\ntwo\n');
    assert.equal((await runManifest({ root, env })).code.fingerprint, m.code.fingerprint);
    await put(['scripts', 'a.mjs'], 'one\ntwo changed\n');
    assert.notEqual((await runManifest({ root, env })).code.fingerprint, m.code.fingerprint);
    const d = await dataManifest({ root });
    assert.deepEqual({ ...d, fingerprint: d.fingerprint.length }, { prices: { 'A.NS': { bars: 2, lastSession: '2026-10-14', retrievedAt: 'r' },
      'B.NS': { bars: 1, lastSession: '2026-10-12', retrievedAt: null } }, oldestLastSession: '2026-10-12', newestLastSession: '2026-10-14', fingerprint: 16 });
    assert.equal(await fingerprint([], root), (await fingerprint([], root))); // stable on nothing
    // the cycle appends one manifest per run, completed with the data at the end; a failing description never stops it
    const journalPath = join(root, 'day.json'), steps = [{ id: 'one', cmd: 'x' }];
    await runCycle({ steps, journalPath, run: async () => ({ code: 0 }), manifest: async () => ({ code: { fingerprint: 'f' } }), data: async () => ({ newestLastSession: 'd' }) });
    await runCycle({ steps, journalPath, run: async () => ({ code: 0 }), manifest: async () => { throw new Error('unreadable'); } });
    const runs = JSON.parse(await readFile(journalPath, 'utf8')).runs;
    assert.equal(runs.length, 2);
    assert.deepEqual([runs[0].code, runs[0].data, typeof runs[0].finishedAt], [{ fingerprint: 'f' }, { newestLastSession: 'd' }, 'string']);
    assert.equal(runs[1].error, 'unreadable');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the rule bot gets a second, release-gated pass after today\'s fills, so its entries are reviewed at the same close', async () => {
  const before = process.env.RULE_BOT_ID;
  try {
    process.env.RULE_BOT_ID = 'momentum-rules';
    const ids = (await planSteps({ root: '/nowhere' })).map(s => s.id);
    const at = id => ids.indexOf(id);
    assert.ok(at('rule-bot') < at('eod-trading') && at('eod-trading') < at('rule-bot-entries') && at('rule-bot-entries') < at('eod-trading-entries'));
    assert.ok(at('eod-trading-entries') < at('score-signals'));
    assert.ok((await planSteps({ root: '/nowhere' })).find(s => s.id === 'rule-bot-entries').releaseGate);
    delete process.env.RULE_BOT_ID;
    assert.equal((await planSteps({ root: '/nowhere' })).some(s => s.id === 'rule-bot-entries'), false);
  } finally { if (before === undefined) delete process.env.RULE_BOT_ID; else process.env.RULE_BOT_ID = before; }
});

test('the bigger decision model is used for the debate and TradingAgents only once it passed the exams and answers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'org-decision-'));
  const before = { bull: process.env.DEBATE_BULL_BOT, bear: process.env.DEBATE_BEAR_BOT };
  try {
    const up = async () => ({ ok: true }), down = async () => { throw new Error('ECONNREFUSED'); };
    assert.equal(await decisionModel({ root: dir, fetchImpl: up }), null);                       // no routing: the usual model
    await mkdir(join(dir, '.local', 'models'), { recursive: true });
    await writeFile(join(dir, '.local', 'models', 'routing.json'), JSON.stringify({ decision: { alias: 'Big-9B', baseUrl: 'http://127.0.0.1:8081/v1' } }));
    assert.deepEqual(await decisionModel({ root: dir, fetchImpl: up }), { HERMES_MODEL_BASE_URL: 'http://127.0.0.1:8081/v1', HERMES_MODEL: 'Big-9B' });
    assert.equal(await decisionModel({ root: dir, fetchImpl: down }), null);                     // its server is down: fall back
    process.env.DEBATE_BULL_BOT = 'bull'; process.env.DEBATE_BEAR_BOT = 'bear';
    const big = { HERMES_MODEL_BASE_URL: 'http://127.0.0.1:8081/v1', HERMES_MODEL: 'Big-9B' };
    const plan = await planSteps({ root: dir, withModel: true, decisionCheck: async () => big });
    assert.deepEqual(plan.find(s => s.id === 'debate').env, big);
    assert.equal(plan.find(s => s.id === 'claims-and-fact-check').env, undefined);                // the bulk work stays on the small model
    assert.equal((await planSteps({ root: dir, withModel: true, decisionCheck: async () => null })).find(s => s.id === 'debate').env, undefined);
  } finally {
    for (const [k, v] of [['DEBATE_BULL_BOT', before.bull], ['DEBATE_BEAR_BOT', before.bear]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await rm(dir, { recursive: true, force: true });
  }
});

test('the broad research data is refreshed a little each day, never in a replay, and feeds the lab and the lessons', async () => {
  const before = process.env.REPLAY_PRICES;
  try {
    delete process.env.REPLAY_PRICES;
    const plan = await planSteps({ root: '/nowhere' });
    const ids = plan.map(s => s.id);
    assert.ok(ids.indexOf('broad-data') < ids.indexOf('factor-lab') && ids.indexOf('factor-lab') < ids.indexOf('factor-forward')
      && ids.indexOf('factor-forward') < ids.indexOf('organisation-lessons'));
    const broad = plan.find(s => s.id === 'broad-data');
    assert.ok(broad.args.includes('--max-age-days') && broad.args.includes('--limit') && broad.requires);
    assert.ok(plan.find(s => s.id === 'factor-lab').args.includes('--monthly'));
    assert.ok(ids.indexOf('world-stories') < ids.indexOf('market-pulse') && ids.indexOf('market-pulse') < ids.indexOf('debate'));
    assert.ok(ids.indexOf('market-pulse') < ids.indexOf('reaction-study') && ids.indexOf('reaction-study') < ids.indexOf('organisation-lessons'));
    process.env.REPLAY_PRICES = 'x';
    assert.ok((await planSteps({ root: '/nowhere' })).find(s => s.id === 'broad-data').skip);
  } finally { if (before === undefined) delete process.env.REPLAY_PRICES; else process.env.REPLAY_PRICES = before; }
});

test('a model step that keeps failing rests behind an open circuit, tries again later, and one success closes it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'circuit-'));
  try {
    let clock = Date.parse('2026-10-10T12:00:00Z'), ok = false;
    const ran = [];
    const steps = [{ id: 'debate', cmd: 'x' }, { id: 'market-data', cmd: 'x' }];
    const day = n => runCycle({ steps, journalPath: join(dir, `${n}.json`), now: () => new Date(clock), escalateStep: async () => 'incident',
      run: async s => { ran.push(s.id); return { code: ok || s.id !== 'debate' ? 0 : 1, tail: 'MODEL_TIMEOUT' }; } });
    for (let n = 1; n <= CIRCUIT_AFTER; n++) { await day(n); clock += 86_400_000; }  // three failed days: the circuit opens
    ran.length = 0;
    const resting = await day(4);
    assert.equal(resting.find(r => r.id === 'debate').status, 'skipped');
    assert.match(resting.find(r => r.id === 'debate').reason, /circuit open after 3 failed runs/);
    assert.deepEqual(ran, ['market-data']);                          // other steps are unaffected; the model is not called
    clock += CIRCUIT_REST_MS;                                          // the rest is over: one try, which fails and re-opens
    await day(5);
    clock += 86_400_000;
    assert.equal((await day(6)).find(r => r.id === 'debate').status, 'skipped');
    clock += CIRCUIT_REST_MS; ok = true;                               // the next try succeeds and closes the circuit
    assert.equal((await day(7)).find(r => r.id === 'debate').status, 'done');
    clock += 86_400_000; ok = false;
    assert.equal((await day(8)).find(r => r.id === 'debate').status, 'failed'); // closed again: a single failure just fails
    // a step that is not a model agent never rests
    assert.equal(circuitOpen('market-data', { failures: 9, openedAt: new Date(clock).toISOString() }, clock), null);
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
