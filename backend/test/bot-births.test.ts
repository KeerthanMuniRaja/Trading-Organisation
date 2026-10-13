import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, config, owner, researcher, evaluator, trader, key } from './helpers.js';
import { BotBirths } from '../src/bot-births.js';
import { Departments } from '../src/departments.js';
import { Database } from '../src/database.js';
import { createApp } from '../src/app.js';

const says = (pattern: RegExp) => (error: any) => pattern.test(JSON.stringify(error?.getResponse?.() ?? error?.message));

async function setup() {
  const f = await fixture();
  const e = await f.evidence();
  await f.org.bot(owner, key(), { id: 'bot-one', name: 'Trend analyst', department: 'desk', specialty: 'trend', method: 'reasoning', contribution: 'Fixture', budgetPaise: '500000' });
  const depts = new Departments(f.db);
  const p = await depts.propose(researcher, key(), { kind: 'open', departmentId: 'desk', name: 'Desk', mandate: 'Paper trading of eight NSE shares',
    rationale: 'Existing trend analyst', evidenceIds: [e.evidenceId] });
  await depts.decide(owner, key(), { proposalId: p.id, outcome: 'approved', budgetPaise: '2000000', note: 'Open' });
  await depts.appointLead(owner, key(), { departmentId: 'desk', leadBotId: 'bot-one' });
  const birth = { botId: 'earnings-reader', name: 'Earnings reader', department: 'desk', specialty: 'earnings-news', method: 'reasoning',
    contribution: 'Reads verified quarterly-result claims for the eight shares', opportunity: 'Results season moves shares; no bot reads results today',
    successCriterion: 'Beats always-neutral on next-day direction after results, sign test over 20+ disagreements', evidenceIds: [e.evidenceId] };
  return { ...f, e, births: new BotBirths(f.db), birth, depts };
}

test('a bot proposes a specialist with evidence; only the owner gives birth, into school with zero budget', async () => {
  const f = await setup(); try {
    assert.throws(() => f.births.propose(trader, key(), f.birth));
    assert.throws(() => f.births.propose(owner, key(), f.birth)); // the owner decides rather than proposes
    await assert.rejects(() => f.births.propose(researcher, key(), { ...f.birth, department: 'research' }), says(/active registered department/));
    await assert.rejects(() => f.births.propose(researcher, key(), { ...f.birth, botId: 'copy', specialty: 'trend' }), says(/existing bot/));
    const unverified = await f.org.evidence(researcher, key(), { sourceId: f.e.sourceId, kind: 'news', content: 'Rumour ' + key(), publishedAt: '2025-01-01T00:00:00Z' });
    await assert.rejects(() => f.births.propose(researcher, key(), { ...f.birth, evidenceIds: [unverified.id] }), says(/verified/));

    const proposal = await f.births.propose(researcher, key(), f.birth);
    await assert.rejects(() => f.births.propose(evaluator, key(), { ...f.birth, botId: 'second-reader' }), says(/another proposal/));
    const view = await f.births.list(owner);
    assert.deepEqual([view.proposals[0]!.status, view.proposals[0]!.similarBots], ['pending', []]);
    assert.throws(() => f.births.decide(researcher, key(), { proposalId: proposal.id, outcome: 'approved', note: 'self-approval' }));

    const born = await f.births.decide(owner, key(), { proposalId: proposal.id, outcome: 'approved', note: 'Results season is coming' });
    assert.deepEqual([born.botId, born.state, born.budgetPaise, born.mentorId], ['earnings-reader', 'school', '0', 'bot-one']); // mentored by the lead
    const bot = (await f.db.transaction(tx => tx.query("SELECT state,budget_paise::text AS b,mentor_id,novelty_key FROM bots WHERE id='earnings-reader'"))).rows[0]!;
    assert.deepEqual([bot.state, bot.b, bot.mentor_id, bot.novelty_key], ['school', '0', 'bot-one', 'desk:earnings-news:reasoning']);
    await assert.rejects(() => f.births.decide(owner, key(), { proposalId: proposal.id, outcome: 'rejected', note: 'again' }), says(/already decided/));
    // the same capability can never be born twice, even through a new proposal
    await assert.rejects(() => f.births.propose(researcher, key(), { ...f.birth, botId: 'earnings-reader-2' }), says(/existing bot/));
    await assert.rejects(() => f.db.transaction(tx => tx.query("UPDATE bot_birth_decisions SET outcome='rejected'")));
    assert.equal((await f.ops.verifyAudit(owner)).valid, true);
  } finally { await f.db.close(); }
});

test('a rejected proposal frees the capability for a better-argued one; a closed department blocks birth', async () => {
  const f = await setup(); try {
    const first = await f.births.propose(researcher, key(), f.birth);
    await f.births.decide(owner, key(), { proposalId: first.id, outcome: 'rejected', note: 'Success criterion too vague' });
    const second = await f.births.propose(evaluator, key(), { ...f.birth, successCriterion: 'Beats always-neutral, p < 0.05, 25+ disagreements' });
    // the department closes before the owner decides
    const close = await f.depts.propose(evaluator, key(), { kind: 'close', departmentId: 'desk', rationale: 'Merged elsewhere', evidenceIds: [f.e.evidenceId] });
    await f.depts.decide(owner, key(), { proposalId: close.id, outcome: 'approved', note: 'Closed' });
    await assert.rejects(() => f.births.decide(owner, key(), { proposalId: second.id, outcome: 'approved', note: 'go' }), says(/no longer active/));
    assert.equal((await f.db.transaction(tx => tx.query("SELECT 1 FROM bots WHERE id='earnings-reader'"))).rows.length, 0);
  } finally { await f.db.close(); }
});

test('birth routes are guarded by role', async () => {
  const { cfg } = config(), db = await Database.open(), app = await createApp(cfg, db, true);
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const token = (role: string) => 'Bearer ' + cfg.principals.find(p => p.role === role)!.token;
    assert.equal((await fetch(base + '/v1/bots/births', { headers: { Authorization: token('researcher') } })).status, 200);
    const post = (path: string, role: string) => fetch(base + '/v1' + path, { method: 'POST', body: '{}',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key(), Authorization: token(role) } });
    assert.equal((await post('/bots/births/decisions', 'researcher')).status, 403);
    assert.equal((await post('/bots/births/proposals', 'trader')).status, 403);
  } finally { await app.close(); await db.close(); }
});
