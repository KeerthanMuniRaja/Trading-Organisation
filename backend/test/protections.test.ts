import test from 'node:test';
import assert from 'node:assert/strict';
import { owner, trader, evaluator, market, fixture, key } from './helpers.js';
import { activePauses, Protections } from '../src/protections.js';
import { OwnerDigest } from '../src/owner-digest.js';
import { TradeSignals, RULES_VERSION } from '../src/trade-signals.js';

const DAY = 86_400_000;

test('protections pause new buys by themselves after losses, never exits, and lift by themselves', async () => {
  const f = await fixture();
  try {
    const e = await f.evidence(); await f.deposit('500000');
    await f.org.bot(owner, key(), { id: 'bot-one', name: 'Fixture', department: 'research', specialty: 'demo', method: 'test', contribution: 'Protection fixture', budgetPaise: '1000000' });
    await f.db.transaction(tx => tx.query("UPDATE bots SET state='paper' WHERE id='bot-one'"));
    const quote = (symbol: string, paise: string) => f.paper.quote(market, key(), { symbol, bidPaise: paise, askPaise: paise, observedAt: new Date().toISOString(), sourceId: e.sourceId });
    const order = async (symbol: string, side: 'buy' | 'sell', quantity: number) => {
      const o = await f.paper.reserve(trader, key(), { botId: 'bot-one', symbol, side, quantity, evidenceId: e.evidenceId });
      return f.paper.fill(trader, key(), { orderId: o.id });
    };
    const protections = new Protections(f.db);
    const pauses = (now = Date.now(), symbol: string | null = null) => f.db.transaction(tx => activePauses(tx, 'bot-one', symbol, now), false);

    // with no policy nothing is ever paused
    await quote('DEMO', '10000'); await quote('OTHER', '10000');
    await order('DEMO', 'buy', 20); await order('OTHER', 'buy', 5);
    assert.deepEqual(await pauses(), []);

    // only the owner sets the thresholds; not the standing-approvals agent, not a trader; rules are bounded
    assert.throws(() => protections.setPolicy(trader, key(), { rules: {}, reason: 'x' }));
    assert.throws(() => protections.setPolicy({ id: 'autonomy-policy', role: 'owner' }, key(), { rules: {}, reason: 'x' }), /owner, not by standing approvals/);
    assert.throws(() => protections.setPolicy(owner, key(), { rules: { dailyLossPct: 80 }, reason: 'too loose' }));
    await protections.setPolicy(owner, key(), { rules: { dailyLossPct: 1, losingExits: { inARow: 2, pauseDays: 3 }, shareCooldownDays: 2 }, reason: 'Founder thresholds' });

    // a losing exit of 10 shares at 9,000 from 10,000 paise: a 10,000-paise realised loss, 1% of the 10,00,000 budget
    await quote('DEMO', '9000');
    await order('DEMO', 'sell', 10);
    assert.deepEqual((await pauses(Date.now(), 'DEMO')).map(p => p.code), ['protection-daily-loss', 'protection-share-cooldown']);
    await assert.rejects(() => f.paper.reserve(trader, key(), { botId: 'bot-one', symbol: 'OTHER', side: 'buy', quantity: 1, evidenceId: e.evidenceId }),
      /New buys are paused by protection \(protection-daily-loss\); exits stay allowed/);
    await order('DEMO', 'sell', 5); // exits stay allowed: a second losing exit, now two in a row
    assert.deepEqual((await pauses()).map(p => p.code), ['protection-daily-loss', 'protection-losing-streak']);

    // the review records each pause as a reason
    const signals = new TradeSignals(f.db, f.cfg);
    const buy = await signals.propose(trader, key(), { botId: 'bot-one', symbol: 'OTHER', action: 'enter-long', horizonDays: 5, conviction: 'medium', thesis: 't', invalidation: 'i',
      expiresAt: new Date(Date.now() + DAY).toISOString(), evidenceIds: [e.evidenceId] });
    const reviewed = await signals.review(evaluator, key(), { signalId: buy.id });
    assert.equal(reviewed.outcome, 'rejected');
    assert.ok(reviewed.reasons.includes('protection-daily-loss') && reviewed.reasons.includes('protection-losing-streak'));
    assert.equal(RULES_VERSION, 'signal-risk-v3');

    // they lift by themselves: the daily window rolls on after a day, the cooldown after 2, the streak after 3
    assert.deepEqual((await pauses(Date.now() + 1.5 * DAY, 'DEMO')).map(p => p.code), ['protection-losing-streak', 'protection-share-cooldown']);
    assert.deepEqual((await pauses(Date.now() + 2.5 * DAY, 'DEMO')).map(p => p.code), ['protection-losing-streak']);
    assert.deepEqual(await pauses(Date.now() + 3.5 * DAY, 'DEMO'), []);
    // a later lenient policy replaces it at once; the history stays
    const status = await protections.status(owner, {});
    assert.equal(status.paused[0]!.botId, 'bot-one');
    await protections.setPolicy(owner, key(), { rules: {}, reason: 'Brakes off for a test' });
    assert.deepEqual(await pauses(), []);
    assert.equal((await f.db.transaction(tx => tx.query('SELECT COUNT(*)::int AS n FROM protection_policies'), false)).rows[0]!.n, 2);
    await assert.rejects(() => f.db.transaction(tx => tx.query("UPDATE protection_policies SET reason='x'")));

    // the digest says whether brakes are set and who is paused
    const d = await new OwnerDigest(f.db, f.cfg).digest(owner, {});
    assert.deepEqual(d.protections, { policySet: true, paused: [] });
    assert.throws(() => protections.status(trader, {}));
  } finally { await f.db.close(); }
});
