import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render, run } from './daily-digest.mjs';

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
  links: { headlines: 900, drivers: 17, carrying: ['crude-oil'], verdicts: { 'link-carries-information': 1, 'insufficient-evidence': 12 } } };
  const text = render(digest, world);
  assert.match(text, /Feeds working: 2 of 3 enabled; countries covered: CN, IN, US/);
  assert.match(text, /40 items in 31 stories; 2 across countries, 1 reach the shares/);
  assert.match(text, /\[IN, US\] Fed holds rates — 2 publishers; inferred: us-fed-rates → HDFCBANK, INFY/);
  assert.match(text, /Driver links tested on 900 headlines: 1 of 17 carry information \(crude-oil\); 12 need more events/);
  assert.doesNotMatch(text, /football/); // stories that reach no share stay in the file, not the digest
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
  assert.doesNotMatch(render(digest), /Market regime/);
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
    const result = await run(env, { fetchImpl, outDir: dir, world: null, regime: null });
    assert.equal(result.webhook, true);
    assert.match(await readFile(join(dir, '2026-10-14.md'), 'utf8'), /Needs you/);
    assert.equal(sent[1].auth, undefined); // the backend credential never goes to the webhook
    assert.match(JSON.parse(sent[1].body).message, /P&L ₹238; 4 proposals, 2 executed; 1 item\(s\) need you/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
