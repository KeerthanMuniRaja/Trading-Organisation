import test from 'node:test';
import assert from 'node:assert/strict';
import { gather, render } from './status.mjs';

const FACTS = {
  at: '2026-10-20T11:00:00.000Z', backend: true, model: false, next: [{ id: 'readiness', at: Date.parse('2026-10-21T03:30:00Z') }],
  digest: { halted: false, money: { realisedPaise: '0', unrealisedPaise: '-9779', totalPaise: '-10194', stalePositions: 0,
    byBot: [{ botId: 'momentum-rules', totalPaise: '-10194', returnOnBudgetPct: -2.04 }] },
    benchmark: [{ botId: 'momentum-rules', excessPct: -0.4, risk: { volatilityPct: null } }], liveFitness: [], needsOwner: ['1 management recommendation(s) await your decision (npm run agenda).'],
    organisation: { suspendedBots: [] } },
  agenda: { waiting: 1 }, autonomy: { policy: null },
  bots: [{ id: 'momentum-rules', state: 'paper', suspended: false, release: { version: 2, stage: 'active' } }, { id: 'tradingagents', state: 'school', suspended: false, release: null }],
  lastCycle: { day: '2026-10-20', failed: [] }, ideas: 0, scout: { through: '2026-09', ideasTried: 13, passing: 0 },
  tradingagents: { day: '2026-10-23', ratings: { HDFCBANK: 'BUY', ITC: null } },
};

test('one screen: health, autonomy, agenda, every member, money, the day and what needs the owner', () => {
  const text = render(FACTS).join('\n');
  assert.match(text, /Backend   up    Model down/);
  assert.match(text, /no standing approvals: every decision waits for you/);
  assert.match(text, /1 decision\(s\) waiting \(npm run agenda\)/);
  assert.match(text, /momentum-rules +paper; release v2 active; P&L Rs -101\.94 \(-2\.04% of budget\); -0\.4 pts vs basket/);
  assert.match(text, /tradingagents +school; no release \(shadow\)/);
  assert.match(text, /R&D +0 invented idea\(s\) in the ledger; last screen 2026-09: 0 passing of 13/);
  assert.match(text, /TradingAgents  last decided 2026-10-23: HDFCBANK BUY, ITC \?/);
  assert.match(text, /Needs you\n  - 1 management recommendation/);
  const policy = render({ ...FACTS, autonomy: { policy: { sequence: 2, setAt: '2026-10-21T00:00:00Z', setBy: 'owner', rules: { suspendOnRecommendation: true, raiseBudget: null } } } }).join('\n');
  assert.match(policy, /policy 2 \(set 2026-10-21 by owner\): suspendOnRecommendation/);
  assert.match(render({ ...FACTS, backend: false }).join('\n'), /DOWN \(npm start\)[\s\S]*Nothing more can be read/);
  const down = render({ ...FACTS, backend: false, regime: { risk: 'SEVERE', date: '2026-10-19', distributionDays: 9, breadth200d: 1, shares: 8, exposureCeilingPct: 0 } }).join('\n');
  assert.match(down, /Regime    SEVERE on 2026-10-19 \(9 distribution days; 1\/8 above 200-day\); advisory ceiling 0%/); // local files need no backend
  const known = render({ ...FACTS, knowledge: { unknown: [{ step: 'x' }], live: { research: { ideasTried: 17, from: '2017-12', through: '2026-09', passing: [],
    best: [{ name: 'momentum-6m-top3' }], lowestRisk: { name: 'equal-weight-distribution', maxDrawdownPct: -9.05 } } } } }).join('\n');
  assert.match(known, /Research  17 ideas on 2017-12..2026-09: none passes; best momentum-6m-top3; lowest risk equal-weight-distribution \(worst fall -9.05%\); 1 unknown cycle problem\(s\)/);
  const world = render({ ...FACTS, world: { coverage: { countriesCovered: ['IN', 'US'] }, stories: { windowHours: 48, stories: 30, crossBorder: 3, reachingShares: 9 },
    links: { drivers: 17, carrying: ['crude-oil'] } } }).join('\n');
  assert.match(world, /World     feeds working in IN, US; last 48h: 30 stories, 3 across countries, 9 reach the shares; links carrying information: crude-oil of 17/);
  const forward = render({ ...FACTS, forward: [
    { name: 'm12', status: 'waiting', monthsJudged: 0, monthsNeeded: 24, firstMonth: '2026-11', waitingForDataFrom: null },
    { name: 'm6', status: 'running', monthsJudged: 3, monthsNeeded: 24, averageExcessPct: 0.41, ahead: 2, icTStat: 0.9, waitingForDataFrom: '2027-02' }] }).join('\n');
  assert.match(forward, /Forward   m12: waiting \(first month 2026-11\)/);
  const models = render({ ...FACTS, tuning: { measuredAt: '2026-10-28T20:00:00Z', runtime: 'cpu', threads: 4, threadsBatch: 8, secondsPerCall: 31.2 },
    routing: { decision: { alias: 'Qwen3.5-9B-Q4_K_M', examOverall: 'SHIP', decidedAt: '2026-10-28T21:00:00Z' } } }).join('\n');
  assert.match(models, /Models    tuned 2026-10-28: CPU, 4 threads \(8 for prompts\), about 31.2s a typical call; decisions: Qwen3.5-9B-Q4_K_M \(exams SHIP 2026-10-28\)/);
  assert.doesNotMatch(render(FACTS).join('\n'), /Models /);                     // nothing measured yet: no line
  assert.match(render({ ...FACTS, supervisor: { state: 'stuck', next: 'news', nextAt: '2026-10-28T07:00:00.000Z' } }).join('\n'),
    /Supervisor STUCK: news was due at 07:00 UTC and did not start; restart it/);
  const pulse = render({ ...FACTS, pulse: { windowDays: 7, counts: { up: 2, down: 1, bigPlayers: 1, unexplainedDeskMoves: 1 },
    movers: [{ company: 'KEI Industries Ltd.', direction: 'down', pct: 8 }, { company: 'Welspun Corp Ltd.', direction: 'up', pct: 230, period: 'YTD' },
      { company: 'Mankind Pharma Ltd.', direction: 'up', pct: 8 }],
    flows: [{ actors: ['foreign-investors'], action: 'buy', amountCrore: 6500 }],
    market: { asOf: '2026-10-27', freshShares: 480, breadthAbove200Pct: 34, sectors: [{ sector: 'Information Technology', monthPct: 11.8 },
      { sector: 'Media', monthPct: 6 }, { sector: 'Realty', monthPct: -8.9 }, { sector: 'Construction', monthPct: -12.1 }] } } }).join('\n');
  assert.match(pulse, /Sectors   1 month to 2026-10-27: best Information Technology \+11.8%, Media \+6%; worst Realty -8.9%, Construction -12.1%; 34% of 480 NIFTY 500 shares above their 200-day average/);
  assert.match(pulse, /Pulse     7d: 2 up, 1 down in the press \(KEI Industries -8%, Mankind Pharma \+8%\); 1 big-player item\(s\); flows: foreign-investors buy Rs 6,500 cr; 1 UNEXPLAINED desk move\(s\)/);
  assert.match(forward, /Forward   m6: running, 3\/24 months, top fifth \+0.41% a month \(ahead 2\/3\), IC t 0.9; waiting for 2027-02 prices/);
});

test('it only reads: GET routes, and the digest and release views', async () => {
  const methods = [];
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    methods.push([init.method ?? 'GET', path]);
    const answers = { '/v1/health': { mode: 'paper' }, '/v1/bots': [{ id: 'a', state: 'paper' }], '/v1/organisation/agenda': { waiting: 0 }, '/v1/autonomy': { policy: null },
      '/v1/owner/digest': { organisation: { suspendedBots: [] } }, '/v1/releases/view': { active: null, releases: [] } };
    return { ok: true, json: async () => answers[path] ?? {} };
  };
  const facts = await gather({ PRINCIPALS_JSON: JSON.stringify([{ role: 'owner', token: 'o' }]) }, { fetchImpl, root: '/nonexistent', now: Date.parse('2026-10-20T11:00:00Z') });
  assert.equal(facts.bots[0].id, 'a');
  assert.ok(methods.every(([m, p]) => m === 'GET' || ['/v1/owner/digest', '/v1/releases/view'].includes(p)));
});
