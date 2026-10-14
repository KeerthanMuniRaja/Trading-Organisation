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

test('the run writes the note locally and sends only a short summary to an optional webhook', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'digest-'));
  try {
    const sent = [];
    const fetchImpl = async (url, init) => {
      sent.push({ url, auth: init.headers.Authorization, body: init.body });
      return url.endsWith('/v1/owner/digest') ? { ok: true, json: async () => digest } : { ok: true };
    };
    const env = { PRINCIPALS_JSON: JSON.stringify([{ id: 'e', role: 'evaluator', token: 'eval-token' }]), ALERT_WEBHOOK_URL: 'https://notify.example/t' };
    const result = await run(env, { fetchImpl, outDir: dir });
    assert.equal(result.webhook, true);
    assert.match(await readFile(join(dir, '2026-10-14.md'), 'utf8'), /Needs you/);
    assert.equal(sent[1].auth, undefined); // the backend credential never goes to the webhook
    assert.match(JSON.parse(sent[1].body).message, /P&L ₹238; 4 proposals, 2 executed; 1 item\(s\) need you/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
