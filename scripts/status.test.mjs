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
