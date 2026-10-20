import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, config, owner, researcher, evaluator, trader, key } from './helpers.js';
import { Hackathons } from '../src/hackathons.js';
import { Database } from '../src/database.js';
import { createApp } from '../src/app.js';

const says = (pattern: RegExp) => (error: any) => pattern.test(JSON.stringify(error?.getResponse?.() ?? error?.message));
const scout = { id: 'scout', role: 'researcher' as const, botId: 'bot-two' };

async function setup() {
  const f = await fixture();
  const e = await f.evidence();
  for (const id of ['bot-one', 'bot-two'])
    await f.org.bot(owner, key(), { id, name: id, department: 'research', specialty: id, method: 'test', contribution: 'Hackathon fixture ' + id, budgetPaise: '0' });
  const contest = { id: 'monthly-allocation-2026', title: 'Beat the basket monthly', question: 'Which monthly allocation rule beats holding the basket after costs?',
    metric: 'net return over the window (%)', higherIsBetter: true, baseline: 'equal-weight buy and hold',
    entryDeadline: new Date(Date.now() + 60_000).toISOString(), maxEntriesPerBot: 2,
    windowFrom: new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10), windowTo: new Date(Date.now() + 200 * 86_400_000).toISOString().slice(0, 10) };
  return { ...f, e, hack: new Hackathons(f.db), contest };
}

test('one full hackathon: concealed window, versioned entries, independent judging, findings, closure', async () => {
  const f = await setup(); try {
    assert.throws(() => f.hack.create(researcher, key(), f.contest)); // only the owner poses challenges
    // a window that opens before entries close could be fitted by the entrants: refused
    assert.throws(() => f.hack.create(owner, key(), { ...f.contest, windowFrom: new Date().toISOString().slice(0, 10) }), says(/after the entry deadline/));
    const created = await f.hack.create(owner, key(), f.contest);
    assert.match(created.windowCommit, /^[0-9a-f]{64}$/);

    const first = await f.hack.enter(trader, key(), { hackathonId: f.contest.id, botId: 'bot-one', title: 'Top-3 momentum', spec: { rule: 'top3-momentum-6m' } });
    assert.equal(first.version, 1);
    assert.equal((await f.hack.enter(trader, key(), { hackathonId: f.contest.id, botId: 'bot-one', title: 'Again', spec: { rule: 'top3-momentum-6m' } })).duplicate, true);
    assert.throws(() => f.hack.enter(trader, key(), { hackathonId: f.contest.id, botId: 'bot-two', title: 'Impersonation', spec: { rule: 'x' } }), says(/own identity/));
    await assert.rejects(() => f.hack.enter(scout, key(), { hackathonId: f.contest.id, botId: 'bot-two', title: 'Copy', spec: { rule: 'top3-momentum-6m' } }),
      says(/another bot/)); // copying another bot's specification is refused
    await f.hack.enter(scout, key(), { hackathonId: f.contest.id, botId: 'bot-two', title: 'Trend filter', spec: { rule: 'equal-weight-trend-filter' } });
    await f.hack.enter(trader, key(), { hackathonId: f.contest.id, botId: 'bot-one', title: 'Inverse volatility', spec: { rule: 'inverse-volatility' } });
    await assert.rejects(() => f.hack.enter(trader, key(), { hackathonId: f.contest.id, botId: 'bot-one', title: 'Third', spec: { rule: 'cash' } }), says(/limit/));

    const during = await f.hack.view(trader, { hackathonId: f.contest.id });
    assert.equal(during.window, 'concealed until entries close');
    assert.deepEqual(during.entries.map(e => e.botId), ['bot-one', 'bot-one']); // a trader sees only its own entries while open
    assert.equal(typeof (await f.hack.view(owner, { hackathonId: f.contest.id })).window, 'object'); // the owner set it and can see it

    await assert.rejects(() => f.hack.closeEntries(owner, key(), { hackathonId: f.contest.id }), says(/deadline/));
    await f.db.transaction(tx => tx.query("UPDATE hackathons SET entry_deadline=now()-interval '1 second' WHERE id=$1", [f.contest.id]));
    const judging = await f.hack.closeEntries(owner, key(), { hackathonId: f.contest.id });
    assert.deepEqual([judging.windowFrom, judging.windowTo, judging.commitVerified], [f.contest.windowFrom, f.contest.windowTo, true]);
    await assert.rejects(() => f.hack.enter(trader, key(), { hackathonId: f.contest.id, botId: 'bot-one', title: 'Late', spec: { rule: 'late' } }), says(/closed/));

    const entries = (await f.hack.view(owner, { hackathonId: f.contest.id })).entries;
    const id = (title: string) => entries.find(e => e.title === title)!.id;
    const result = { score: 4.2, baselineScore: 3.1, evidenceId: f.e.evidenceId, note: 'Replayed on the revealed window with real costs' };
    await assert.rejects(() => f.hack.judge({ id: 'trader', role: 'evaluator' }, key(), { entryId: id('Top-3 momentum'), ...result }), says(/own entry/));
    await f.hack.judge(evaluator, key(), { entryId: id('Top-3 momentum'), ...result });
    await f.hack.judge(evaluator, key(), { entryId: id('Trend filter'), ...result, score: -1.0 });
    await assert.rejects(() => f.hack.finish(owner, key(), { hackathonId: f.contest.id }), says(/not judged/));
    await f.hack.judge(evaluator, key(), { entryId: id('Inverse volatility'), ...result, score: 2.9 });
    await assert.rejects(() => f.hack.finish(owner, key(), { hackathonId: f.contest.id }), says(/finding/));
    await f.hack.finding(evaluator, key(), { hackathonId: f.contest.id, kind: 'negative', finding: 'Going to cash below the 200-day average lost to holding.', evidenceId: f.e.evidenceId });
    await f.hack.finding(researcher, key(), { hackathonId: f.contest.id, kind: 'next-step', finding: 'Forward-test top-3 momentum with a drawdown limit.' });
    await f.hack.finish(owner, key(), { hackathonId: f.contest.id });

    const final = await f.hack.view(trader, { hackathonId: f.contest.id });
    assert.equal(final.status, 'closed');
    assert.deepEqual(final.leaderboard.map(l => [l.rank, l.score, l.beatBaseline]), [[1, 4.2, true], [2, 2.9, false], [3, -1, false]]);
    assert.match(final.outcome, /bot-one v1/);
    assert.equal(final.findings.length, 2);
    await assert.rejects(() => f.db.transaction(tx => tx.query('UPDATE hackathon_results SET score=99')));
    assert.equal((await f.ops.verifyAudit(owner)).valid, true);
  } finally { await f.db.close(); }
});

test('a contest where nothing beats the baseline still closes with a negative result', async () => {
  const f = await setup(); try {
    await f.hack.create(owner, key(), { ...f.contest, higherIsBetter: false, metric: 'worst fall (%)' });
    const entry = await f.hack.enter(trader, key(), { hackathonId: f.contest.id, botId: 'bot-one', title: 'All in', spec: { rule: 'top3' } });
    await f.db.transaction(tx => tx.query("UPDATE hackathons SET entry_deadline=now()-interval '1 second' WHERE id=$1", [f.contest.id]));
    await f.hack.closeEntries(owner, key(), { hackathonId: f.contest.id });
    const judged = await f.hack.judge(evaluator, key(), { entryId: entry.id, score: 22.6, baselineScore: 17.0, evidenceId: f.e.evidenceId, note: 'Deeper fall' });
    assert.equal(judged.beatBaseline, false); // lower is better here, and 22.6 is worse than 17.0
    await f.hack.finding(evaluator, key(), { hackathonId: f.contest.id, kind: 'negative', finding: 'No entry reduced the worst fall.' });
    await f.hack.finish(owner, key(), { hackathonId: f.contest.id });
    assert.match((await f.hack.view(owner, { hackathonId: f.contest.id })).outcome, /negative result/);
  } finally { await f.db.close(); }
});

test('hackathon routes are registered and guarded by role', async () => {
  const { cfg } = config(), db = await Database.open(), app = await createApp(cfg, db, true);
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const post = (path: string, role: string) => fetch(base + '/v1' + path, { method: 'POST', body: '{}',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key(), Authorization: 'Bearer ' + cfg.principals.find(p => p.role === role)!.token } });
    assert.equal((await post('/hackathons', 'researcher')).status, 403);
    assert.equal((await post('/hackathons/results', 'trader')).status, 403);
    assert.equal((await post('/hackathons/judging', 'evaluator')).status, 403);
    assert.equal((await post('/hackathons/entries', 'market')).status, 403);
  } finally { await app.close(); await db.close(); }
});
