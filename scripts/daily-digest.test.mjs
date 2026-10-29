import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { arithmeticProblems, firmLines, forwardLines, knowledgeSummary, modelLines, pulseLines, render, run, trustCheck, upcomingEvents } from './daily-digest.mjs';

test('a logged failure the playbook has since learned is no longer reported as unknown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'digest-unknown-'));
  try {
    await mkdir(join(root, '.local', 'cycles'), { recursive: true });
    const at = '2026-10-27T13:32:36Z';
    await writeFile(join(root, '.local', 'cycles', 'unknown-problems.jsonl'), [
      { at, step: 'rnd-scout', status: 'failed', text: "raise EndpointError('ENDPOINT_TIMEOUT') from None" },
      { at, step: 'rnd-scout', status: 'failed', text: 'something nobody has seen: frobnication overflow' }].map(x => JSON.stringify(x)).join('\n') + '\n');
    const known = await knowledgeSummary(root, Date.parse('2026-10-28T12:00:00Z'));
    assert.deepEqual(known.unknown.map(u => u.text), ['something nobody has seen: frobnication overflow']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the models section: measured settings and the decision model, or nothing', () => {
  assert.deepEqual(modelLines(null, null), []);
  const text = modelLines({ measuredAt: '2026-10-28T20:00:00Z', runtime: 'vulkan', threads: 4, threadsBatch: 8, secondsPerCall: 22.5 },
    { decision: { alias: 'Qwen3.5-9B-Q4_K_M', examOverall: 'SHIP', decidedAt: '2026-10-28T21:00:00Z' } }).join('\n');
  assert.match(text, /## Models\n- Measured 2026-10-28: graphics \(Vulkan\), 4 threads \(8 for prompts\), about 22.5s a typical call\n- Decisions \(debate, TradingAgents\): Qwen3.5-9B-Q4_K_M, exams SHIP on 2026-10-28/);
  assert.match(modelLines(null, null).join('') + modelLines({ measuredAt: 'x', runtime: 'cpu', threads: 6, threadsBatch: 6, secondsPerCall: 30 }, null).join('\n'), /the same model as the bulk work/);
  const failed = modelLines(null, null, { tasks: ['debate', 'scenario'], overall: "DON'T SHIP", at: '2026-10-29T12:30:00Z', model: 'Qwen3.5-4B-Q4_K_M',
    runId: '20261029T123000Z', verdicts: { debate: 'SHIP', scenario: "DON'T SHIP" } }).join('\n');
  assert.match(failed, /- Exams \(debate, scenario\): DON'T SHIP on 2026-10-29, Qwen3.5-4B-Q4_K_M — scenario failed: see \.local\/model-eval\/20261029T123000Z\/report\.json/);
});

test('the market pulse section: movers with reasons, flows, sectors, the week and unexplained desk moves', () => {
  assert.deepEqual(pulseLines(null), []);
  const text = pulseLines({ windowDays: 7, counts: { up: 1, down: 1 },
    movers: [{ company: 'KEI Industries Ltd.', direction: 'down', pct: 8, why: 'Q2 profit rising 29%' }, { company: 'Welspun Corp Ltd.', direction: 'up', pct: 230, period: 'YTD' }],
    bigPlayers: [{ actors: ['promoter'], action: 'sell', companies: ['Bandhan Bank Ltd.'], amountCrore: 1200 }],
    flows: [{ actors: ['foreign-investors'], action: 'buy', amountCrore: 6500 }],
    market: { asOf: '2026-10-27', breadthAbove200Pct: 34, sectors: [{ sector: 'IT', monthPct: 11.8 }, { sector: 'Media', monthPct: 6 }, { sector: 'FMCG', monthPct: 1 },
      { sector: 'Realty', monthPct: -8.9 }], risers: [{ company: 'Acutaas Chemicals Ltd.', weekPct: 16.6, why: 'Q2 results' }],
      fallers: [{ company: 'Jindal Saw Ltd.', weekPct: -17.2, why: null }] },
    deskMoves: [{ symbol: 'SBIN.NS', vsBasketPct: -3.1, sigmas: 2.6, date: '2026-10-27', unexplained: true }] }).join('\n');
  assert.match(text, /## Market pulse \(press read by rules over 7 days; NIFTY 500 prices to 2026-10-27\)/);
  assert.match(text, /- In the press: 1 shares reported up, 1 down: KEI Industries -8% \(Q2 profit rising 29%\)\n/);   // the YTD move is not today's news
  assert.match(text, /- Big players: promoter sell Bandhan Bank Rs 1,200 cr/);
  assert.match(text, /- Flows: foreign-investors buy Rs 6,500 cr/);
  assert.match(text, /- Sectors this month: best IT \+11.8%, Media \+6%, FMCG \+1%; worst Media \+6%, FMCG \+1%, Realty -8.9%; 34% of shares above/);
  assert.match(text, /- The week's fallers: Jindal Saw -17.2% \(no news\)/);
  assert.match(text, /- UNEXPLAINED: SBIN.NS -3.1% against the basket on 2026-10-27 \(2.6 of its usual swings\), no news/);
});

const digest = { windowHours: 24, generatedAt: '2026-10-14T18:00:00.000Z', mode: 'paper', halted: false,
  money: { realisedPaise: '25000', unrealisedPaise: '-1200', totalPaise: '23800', realisedInWindowPaise: '25000', byBot: [{ botId: 'bot-one', totalPaise: '23800', returnOnBudgetPct: 2.38 }] },
  trading: { proposed: 4, accepted: 2, rejected: 2, executed: 2, challenges: 1, scored: 3, accuracy: 0.667, lapsed: 1, releasedPaise: '98800', corporateActions: 0 },
  benchmark: [{ botId: 'momentum-rules', from: '2026-10-15', to: '2026-11-14', days: 22, returnPct: -1.2, basketReturnPct: 0.8, excessPct: -2, verdict: 'behind-basket' }],
  organisation: { suspendedBots: ['old-bot'], departmentsActive: 2, departmentsClosed: 1, hackathonsOpen: 1, hackathonsJudging: 0 },
  liveFitness: [{ botId: 'momentum-rules', scope: 'release v1', verdict: 'insufficient-evidence', right: 2, judged: 3 }],
  knowledge: { received: 55, verified: 10, rejected: 3, backlog: 120, setAside: 40 }, alerts: { warning: 1 },
  needsOwner: ['warning: 20 pieces of evidence have waited over 24 hours for review.'],
  bots: { best: [{ botId: 'bot-one', scored: 6, accuracy: 0.667 }], weakest: [] }, compute: { tokens: '45000' }, note: 'Paper results.' };

test('the digest renders as a readable note with what needs the owner first', () => {
  const text = render(digest);
  assert.match(text, /# Organisation digest — 2026-10-14/);
  assert.ok(text.indexOf('## Needs you') < text.indexOf('## Money'));
  assert.match(text, /Total P&L ₹238 \(realised ₹250, open −₹12\)/);
  assert.match(text, /4 proposed, 2 accepted, 2 rejected, 2 executed, 1 challenges/);
  assert.match(text, /best: bot-one 67% of 6/);
  assert.match(text, /1 accepted proposal\(s\) expired unexecuted; ₹988 of reservations released/);
  assert.match(text, /momentum-rules \(release v1\): insufficient-evidence, 2 of 3 right/);
  assert.doesNotMatch(text, /corporate action/); // only shown when there is one
  assert.match(text, /120 waiting for review \(40 more set aside as out of scope\)/);
  assert.match(text, /momentum-rules 2026-10-15\.\.2026-11-14: -1\.2% vs basket \+0\.8% — behind by 2 points/);
  assert.match(render({ ...digest, benchmark: [] }), /No bot has two daily snapshots yet/);
  assert.match(text, /Suspended bots: old-bot/);
  assert.match(text, /Departments: 2 active, 1 closed; hackathons: 1 open, 0 being judged/);
  assert.match(render({ ...digest, liveFitness: undefined }), /No bot has scored live calls yet/); // older backends
});

test('the world section: coverage, stories that reach the shares, and a broken feed under Needs you', () => {
  const world = { coverage: { countriesCovered: ['CN', 'IN', 'US'], advice: ['World news: SCMP business is failing (FEED_HTTP_ERROR ×2); enable its backup: npm run world -- enable cn-scmp-china --yes'],
    sources: [{ state: 'working' }, { state: 'working' }, { state: 'failing' }, { state: 'off' }] },
  stories: { windowHours: 48, items: 40, stories: 31, crossBorder: 2, reachingShares: 1, top: [
    { title: 'Fed holds rates', countries: ['IN', 'US'], publishers: 2, directShares: [], drivers: [{ driver: 'us-fed-rates', region: 'US', shares: ['HDFCBANK', 'INFY'] }] },
    { title: 'A football final', countries: ['WORLD'], publishers: 1, directShares: [], drivers: [] }] },
  links: { headlines: 900, drivers: 17, carrying: ['crude-oil'], verdicts: { 'link-carries-information': 1, 'insufficient-evidence': 12 } },
  scenario: { horizonSessions: 5, waiting: 4, panel: { right: 7, wrong: 5, verdict: 'insufficient-evidence' } } };
  const text = render(digest, world);
  assert.match(text, /Feeds working: 2 of 3 enabled; countries covered: CN, IN, US/);
  assert.match(text, /40 items in 31 stories; 2 across countries, 1 reach the shares/);
  assert.match(text, /\[IN, US\] Fed holds rates — 2 publishers; inferred: us-fed-rates → HDFCBANK, INFY/);
  assert.match(text, /Driver links tested on 900 headlines: 1 of 17 carry information \(crude-oil\); 12 need more events/);
  assert.match(text, /Scenario panel \(shadow\): 7 right, 5 wrong after 5 sessions \(insufficient-evidence\); 4 call\(s\) waiting/);
  assert.doesNotMatch(text, /football/); // stories that reach no share stay in the file, not the digest
  // WORLD-02: a world event, then Indian stories on the same driver
  const echoed = render(digest, { ...world, stories: { ...world.stories, worldEchoes: 1, echoes: [{ driver: 'us-fed-rates',
    abroad: { title: 'Federal Reserve issues FOMC statement', countries: ['US'] }, indianStories: 2, shares: ['HDFCBANK', 'SBIN'] }] } });
  assert.match(echoed, /World events echoed in Indian news \(same driver, later\): 1\n  - \[US\] Federal Reserve issues FOMC statement → 2 Indian stories on us-fed-rates \(HDFCBANK, SBIN\)/);
  assert.ok(text.indexOf('enable cn-scmp-china') < text.indexOf('## Money'));
  assert.doesNotMatch(render(digest), /World news/); // no world data, no section
});

test('the market regime is shown as advice, with what our history says about it', () => {
  const regime = { date: '2026-10-19', risk: 'SEVERE', distributionDays: 9, breadth50d: 1, breadth200d: 1, shares: 8, aboveTrend200d: false, exposureCeilingPct: 0,
    study: { verdict: 'no-clear-warning', horizonSessions: 20, levels: { SEVERE: { fallOver5PctShare: 0.173 }, NORMAL: { fallOver5PctShare: 0.071 } } } };
  const text = render(digest, null, regime);
  assert.match(text, /## Market regime \(advice\)\n- SEVERE on 2026-10-19: 9 distribution day\(s\) in 25 sessions; 1\/8 shares above their 50-day and 1\/8 above their 200-day average; basket below its 200-day trend/);
  assert.match(text, /Advisory exposure ceiling 0% \(not applied to any limit\)\. On our history: no-clear-warning; falls over 5% within 20 sessions followed 17% of SEVERE days and 7% of NORMAL days/);
  assert.ok(text.indexOf('## Market regime') < text.indexOf('## Trading'));
  assert.match(render(digest, null, { ...regime, state: 'stale' }), /- STALE \(do not rely on it\): SEVERE on 2026-10-19/); // never shown as today's
  assert.doesNotMatch(render(digest), /Market regime/);
});

test('the research section and failures the playbook does not know yet', () => {
  const known = { unknown: [{ at: '2026-10-20T11:00:00Z', step: 'odd-step', status: 'failed', text: 'x' }], live: { research: {
    ideasTried: 17, from: '2017-12', through: '2026-09', bar: 0.002941, passing: [],
    best: [{ name: 'momentum-6m-top3', ahead: 61, behind: 45, averageExcessPct: 0.003, beatsRandomPct: 81 }],
    lowestRisk: { name: 'equal-weight-distribution', maxDrawdownPct: -9.05, sharpe: 0.9 }, basket: { maxDrawdownPct: -35.28, sharpe: 0.79 },
    walkForward: { outOfSampleMonths: 70, ahead: 33, behind: 37, averageExcessPct: -0.349 } } } };
  const text = render(digest, null, null, known);
  assert.match(text, /## Research \(seen history, net of costs\)\n- 17 ideas tried on 2017-12..2026-09; passing: none \(bar 0.002941\)/);
  // RND-04: forward tests, judged only on later months
  assert.deepEqual(forwardLines({ maxLive: 5, passed: [], tests: [{ idea: 'momentum-6m-top3-quarterly', status: 'waiting', firstMonth: '2026-11' },
    { idea: 'reversal-1m-bottom3', status: 'running', monthsJudged: 3, monthsNeeded: 24, averageExcessPct: 0.4, tStat: 0.8 }, { idea: 'old', status: 'ended' }] }),
  ['- Forward tests (months after registration only): 2 of 5 running (momentum-6m-top3-quarterly from 2026-11; reversal-1m-bottom3 3/24 months, 0.4% a month, t 0.8)']);
  assert.match(forwardLines({ maxLive: 5, passed: ['x'], tests: [{ idea: 'x', status: 'passed' }] })[0], /0 of 5 running; PASSED: x \(eligible/);
  assert.deepEqual(forwardLines(null), []);
  assert.match(text, /momentum-6m-top3: 61\/45 months vs the basket, 0.003% a month, beats 81% of random pickers/);
  assert.match(text, /Lowest risk: equal-weight-distribution, worst fall -9.05% \(basket -35.28%\), Sharpe 0.9 \(basket 0.79\)/);
  assert.match(text, /walk-forward\): 33\/37 months, -0.349% a month/);
  assert.match(text, /1 cycle failure\(s\) the problem playbook does not know \(odd-step\)/);
  assert.ok(text.indexOf('playbook does not know') < text.indexOf('## Money'));
});

test('the self-check catches figures that do not add up and runs that never finished', async () => {
  assert.deepEqual(arithmeticProblems(digest), []);
  const wrong = { ...digest, money: { ...digest.money, totalPaise: '23900' }, trading: { ...digest.trading, accuracy: 1.5, executed: -1 } };
  assert.deepEqual(arithmeticProblems(wrong), ['total P&L is not realised plus open', 'accuracy 1.5 is outside 0..1', 'a trading count is not a whole number']);
  const root = await mkdtemp(join(tmpdir(), 'crash-'));
  try {
    await mkdir(join(root, '.local', 'cycles'), { recursive: true });
    const run = (at, done) => ({ startedAt: at, ...(done ? { finishedAt: at } : {}), code: { commit: 'c', fingerprint: 'f' } });
    await writeFile(join(root, '.local', 'cycles', '2026-10-14.json'), JSON.stringify({ steps: {},
      runs: [run('2026-10-14T11:00:00Z', false), run('2026-10-14T12:00:00Z', true), run('2026-10-14T13:00:00Z', false)] }));
    const t = await trustCheck(root, Date.parse('2026-10-14T13:30:00Z'), async () => null);
    assert.deepEqual(t.crashedRuns, ['2026-10-14T11:00:00Z']); // the newest unfinished run is this cycle, still running
    const text = render(wrong, null, null, null, t);
    assert.match(text, /Check first: the digest does not add up: total P&L is not realised plus open/);
    assert.match(text, /Check first: 1 cycle run\(s\) never finished \(started 2026-10-14T11:00:00Z\)/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the limits banner shows what the backend loaded and flags settings that differ; refused orders are counted', () => {
  const limits = { maxOrderPaise: '500000', maxExposurePaise: '2000000', maxRealisedLossPaise: '100000', feeBps: 10, slippageBps: 5, realisedLossPaise: '25000', lossLimitUsedPct: 25 };
  const d = { ...digest, limits, trading: { ...digest.trading, refusedOrders: 3, topRefusals: [{ message: 'Bot budget exceeded', count: 2 }, { message: 'New risk is halted', count: 1 }] } };
  const trust = { day: '2026-10-14', crashedRuns: [], cycle: { failed: [], degraded: [], done: 3 }, prices: { newest: '2026-10-14', ageDays: 0.5, behind: [] },
    liveAgeDays: 0.2, indexAgeDays: 0.2, code: null };
  const clean = render(d, null, null, null, { ...trust, env: { MAX_ORDER_PAISE: '500000', PAPER_FEE_BPS: '10' } });
  assert.match(clean, /- Limits the backend loaded: Max order ₹5,000 · organisation exposure ₹20,000 · realised-loss limit ₹1,000 \(₹250 used, 25%\) · fees 10 bps, slippage 5 bps/);
  assert.match(clean, /- Yes: today's cycle/);
  assert.match(clean, /- 3 order\(s\) refused: Bot budget exceeded ×2; New risk is halted ×1/);
  const stale = render(d, null, null, null, { ...trust, env: { MAX_ORDER_PAISE: '100000', PAPER_SLIPPAGE_BPS: '5' } });
  assert.match(stale, /Check first: the running backend loaded different limits from this digest's settings \(MAX_ORDER_PAISE\)/);
  assert.doesNotMatch(stale, /100000/); // names only, never the value it expected
  // B28: under NSE delivery charges the banner says so, and a shell still set to flat is flagged by name
  const nse = { ...d, limits: { ...limits, costModel: 'nse-delivery' } };
  assert.match(render(nse, null, null, null, trust), /charges: NSE delivery \(STT, stamp duty, exchange, GST, Rs 15\.93 DP per sale\), slippage 5 bps/);
  assert.match(render(nse, null, null, null, { ...trust, env: { PAPER_COST_MODEL: 'flat' } }), /different limits from this digest's settings \(PAPER_COST_MODEL\)/);
  assert.doesNotMatch(render(digest), /order\(s\) refused|Limits the backend|Loss brakes/);
  assert.match(render({ ...digest, protections: { policySet: false, paused: [] } }), /- Loss brakes: not set, so losses never pause a bot \(founderReview B3/);
  assert.match(render({ ...digest, protections: { policySet: true, paused: [] } }), /- Loss brakes: set; nothing paused/);
  assert.match(render({ ...digest, protections: { policySet: true, paused: [{ botId: 'momentum-rules', pauses: [{ code: 'protection-daily-loss', until: null },
    { code: 'protection-losing-streak', until: '2026-10-15T10:30:00.000Z' }] }] } }),
  /- Loss brakes: momentum-rules paused \(daily-loss, losing-streak until 2026-10-15 10:30 UTC\); new buys only, each lifts by itself/);
});

test('the digest shows what is coming up from the owner\'s calendar, and nothing when there is none', async () => {
  const root = await mkdtemp(join(tmpdir(), 'events-'));
  try {
    await mkdir(join(root, '.local'), { recursive: true });
    assert.equal(await upcomingEvents(root, Date.parse('2026-10-23T06:00:00Z')), null);
    await writeFile(join(root, '.local', 'events.json'), JSON.stringify({ events: [
      { date: '2026-10-28', kind: 'results', symbols: ['SBIN'], title: 'SBI Q2 results' }, { date: '2026-10-27', kind: 'fomc', title: 'Fed decision' },
      { date: '2026-12-05', kind: 'rbi-policy', title: 'RBI policy' }, { date: 'soon', title: 'bad' }] }));
    const events = await upcomingEvents(root, Date.parse('2026-10-23T06:00:00Z'));
    assert.deepEqual(events.map(e => e.title), ['Fed decision', 'SBI Q2 results']);
    const text = render(digest, null, null, { events });
    assert.match(text, /## Coming up \(next 7 days, from your events calendar and press-reported results and policy days\)\n- 2026-10-27 fomc: Fed decision\n- 2026-10-28 results: SBI Q2 results \(SBIN\)/);
    assert.match(render(digest, null, null, { events: [] }), /Nothing scheduled in the calendar/);
    assert.doesNotMatch(render(digest), /Coming up/);
    // NEWS-07: press-reported results days for desk shares join in; the owner's SBI entry wins over the press one
    await mkdir(join(root, '.local', 'world'), { recursive: true });
    await writeFile(join(root, '.local', 'world', 'results-calendar.json'), JSON.stringify({ events: [
      { date: '2026-10-29', symbol: 'SBIN.NS', company: 'State Bank of India', desk: true },
      { date: '2026-10-26', symbol: 'NTPC.NS', company: 'NTPC', desk: true },
      { date: '2026-10-26', symbol: 'TVSMOTOR.NS', company: 'TVS Motor', desk: false },
      { date: '2026-10-28', kind: 'fomc', symbol: null, company: 'US Federal Reserve decision', desk: false },   // the owner's 27 Oct entry wins
      { date: '2026-10-29', kind: 'rbi-policy', symbol: null, company: 'RBI monetary policy decision', desk: false }] }));
    const both = await upcomingEvents(root, Date.parse('2026-10-23T06:00:00Z'));
    assert.deepEqual(both.map(e => e.title), ['NTPC results (press report, not the exchange filing)', 'Fed decision', 'SBI Q2 results',
      'RBI monetary policy decision (press report, not the official calendar)']);
    await rm(join(root, '.local', 'events.json'));
    assert.equal((await upcomingEvents(root, Date.parse('2026-10-23T06:00:00Z'))).length, 4); // no owner file: the press days still show
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the firm: each department with its ceiling, members and today\'s work, and the work no department owns yet', () => {
  const charters = { desk: { name: 'Trading desk', steps: ['rule-bot', 'eod-trading'] }, research: { name: 'Research', steps: ['rnd-scout', 'debate'] } };
  const registry = { departments: [{ id: 'desk', name: 'Trading desk', status: 'active', budgetPaise: '500000', leadBotId: null,
    members: [{ botId: 'momentum-rules', state: 'paper', budgetPaise: '500000', latestFitness: 'no-detectable-skill' }, { botId: 'tradingagents', state: 'school', budgetPaise: '0' }] }],
  unregisteredLabels: ['research'], pendingProposals: [{ id: 'a1b2c3d4-0000', departmentId: 'research' }] };
  const steps = { 'rule-bot': { status: 'done' }, 'eod-trading': { status: 'failed' }, 'rnd-scout': { status: 'done' }, 'news-livemint': { status: 'done' },
    alerts: { status: 'failed' } };
  const lines = firmLines(registry, steps, charters).join('\n');
  assert.match(lines, /## The firm \(departments\)\n- Trading desk \(active; ceiling ₹5,000(\.00)?, members' budgets ₹5,000(\.00)?; no lead yet\): momentum-rules paper \(no-detectable-skill\), tradingagents school; today 1 step\(s\) done, FAILED: eod-trading/);
  assert.match(lines, /- Research \(not registered: proposal a1b2c3d4 waits for you on the agenda\); today 1 step\(s\) done/);
  assert.match(lines, /- No department owns 2 other step\(s\) yet .*; FAILED: alerts/);
  assert.deepEqual(firmLines(null, steps, charters), []);
});

test('the review scorecard shows how taken and turned-down calls went', () => {
  const review = { calls: 9, verdict: 'insufficient-evidence', accepted: { scored: 5, right: 3, rightPct: 60, buysWithPath: 4, averageWorstPct: -3.1,
    averageBestPct: 4.2, worstPct: -8 }, rejected: { scored: 4, right: 1, rightPct: 25 },
    byRejectionReason: { 'over-budget': { scored: 3, right: 1 }, 'stale-quote': { scored: 1, right: 0 } }, byRegimeAtCall: { SEVERE: { scored: 9, right: 4 } } };
  const text = render(digest, null, null, { review });
  assert.match(text, /## Review scorecard \(scored calls\)\n- Taken: 3 of 5 right \(60%\); turned down: 1 of 4 right \(25%\) — insufficient-evidence/);
  assert.match(text, /by reason \(right\/scored\): over-budget 1\/3, stale-quote 0\/1/);
  assert.match(text, /By the regime when the call was made: SEVERE 4\/9/);
  assert.match(text, /Buys taken, while held: average worst -3.1%, average best 4.2%, deepest -8% \(4 buys\)/);
  assert.doesNotMatch(render(digest, null, null, { review: { calls: 0 } }), /Review scorecard/);
});

test('the trust check says what to check first, or that the digest rests on a clean cycle and fresh inputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trust-'));
  try {
    const now = Date.parse('2026-10-14T18:00:00Z');
    const put = async (path, value) => { await mkdir(join(root, ...path.slice(0, -1)), { recursive: true }); await writeFile(join(root, ...path), JSON.stringify(value)); };
    const share = (symbol, last) => ({ symbol, retrievedAt: '2026-10-14T11:00:00Z', bars: [{ date: '2026-10-13' }, { date: last }] });
    await put(['.local', 'trading-desk', 'daily', 'A.NS-1d.json'], share('A.NS', '2026-10-14'));
    await put(['.local', 'trading-desk', 'daily', 'B.NS-1d.json'], share('B.NS', '2026-10-13'));
    await put(['.local', 'cycles', '2026-10-13.json'], { steps: {}, runs: [{ code: { commit: 'aaa111', fingerprint: 'f1' } }] });
    await put(['.local', 'cycles', '2026-10-14.json'], { steps: { 'market-data': { status: 'done' }, 'link-study': { status: 'failed' } },
      runs: [{ code: { commit: 'bbb222', fingerprint: 'f2' } }] });
    await put(['.local', 'knowledge', 'index-meta.json'], { builtAt: '2026-10-14T12:00:00Z' });
    const t = await trustCheck(root, now);
    assert.deepEqual(t.prices, { newest: '2026-10-14', ageDays: 0.75, behind: ['B.NS'] });
    const text = render(digest, null, { ...{ date: '2026-10-14', risk: 'NORMAL', shares: 8 }, state: 'stale' }, null, t);
    assert.ok(text.indexOf('## Needs you') < text.indexOf('## Can you trust this digest?') && text.indexOf('## Can you trust') < text.indexOf('## Money'));
    for (const x of [/Check first: cycle steps failed: link-study/, /Check first: prices behind the others for B\.NS/, /Check first: the market regime is stale/,
      /Check first: no live knowledge yet/, /Code: commit bbb222 \(fingerprint f2\); changed since the previous run \(aaa111\)/]) assert.match(text, x);
    assert.doesNotMatch(text, /knowledge index is/); // built today
    // all clear
    await put(['.local', 'trading-desk', 'daily', 'B.NS-1d.json'], share('B.NS', '2026-10-14'));
    await put(['.local', 'cycles', '2026-10-14.json'], { steps: { 'market-data': { status: 'done' } }, runs: [{ code: { commit: 'aaa111', fingerprint: 'f1' } }] });
    await put(['.local', 'trading-desk', 'knowledge', 'live.json'], { generatedAt: '2026-10-14T12:00:00Z' });
    const clear = render(digest, null, null, null, await trustCheck(root, now));
    assert.match(clear, /- Yes: today's cycle has 1 step\(s\) done and none failed; prices to 2026-10-14/);
    assert.doesNotMatch(clear, /Check first|changed since/);
    // no cycle today, and prices a week old
    assert.match(render(digest, null, null, null, await trustCheck(root, now + 7 * 86_400_000)),
      /Check first: no organisation cycle has run today \(2026-10-21\)[\s\S]*Check first: prices are stale: last session 2026-10-14/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the run writes the note locally and sends only a short summary to an optional webhook', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'digest-'));
  try {
    const sent = [];
    const fetchImpl = async (url, init) => {
      sent.push({ url, auth: init.headers.Authorization, body: init.body });
      return url.endsWith('/v1/owner/digest') ? { ok: true, json: async () => digest } : { ok: true };
    };
    const env = { PRINCIPALS_JSON: JSON.stringify([{ id: 'e', role: 'evaluator', token: 'eval-token' }]), ALERT_WEBHOOK_URL: 'https://notify.example/t' };
    const result = await run(env, { fetchImpl, outDir: dir, world: null, regime: null, knowledge: null, trust: null, firm: null });
    assert.equal(result.webhook, true);
    assert.match(await readFile(join(dir, '2026-10-14.md'), 'utf8'), /Needs you/);
    assert.equal(sent[1].auth, undefined); // the backend credential never goes to the webhook
    assert.match(JSON.parse(sent[1].body).message, /P&L ₹238; 4 proposals, 2 executed; 1 item\(s\) need you/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
