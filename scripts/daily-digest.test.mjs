import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render, run } from './daily-digest.mjs';

const digest = { windowHours: 24, generatedAt: '2026-10-14T18:00:00.000Z', mode: 'paper', halted: false,
  money: { realisedPaise: '25000', unrealisedPaise: '-1200', totalPaise: '23800', realisedInWindowPaise: '25000', byBot: [{ botId: 'bot-one', totalPaise: '23800', returnOnBudgetPct: 2.38 }] },
  trading: { proposed: 4, accepted: 2, rejected: 2, executed: 2, challenges: 1, scored: 3, accuracy: 0.667 },
  knowledge: { received: 55, verified: 10, rejected: 3, backlog: 120 }, alerts: { warning: 1 },
  needsOwner: ['warning: 20 pieces of evidence have waited over 24 hours for review.'],
  bots: { best: [{ botId: 'bot-one', scored: 6, accuracy: 0.667 }], weakest: [] }, compute: { tokens: '45000' }, note: 'Paper results.' };

test('the digest renders as a readable note with what needs the owner first', () => {
  const text = render(digest);
  assert.match(text, /# Organisation digest — 2026-10-14/);
  assert.ok(text.indexOf('## Needs you') < text.indexOf('## Money'));
  assert.match(text, /Total P&L ₹238 \(realised ₹250, open −₹12\)/);
  assert.match(text, /4 proposed, 2 accepted, 2 rejected, 2 executed, 1 challenges/);
  assert.match(text, /best: bot-one 67% of 6/);
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
