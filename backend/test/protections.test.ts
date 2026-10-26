import test from 'node:test';
import assert from 'node:assert/strict';
import { owner, trader, evaluator, market, fixture, key } from './helpers.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { activePauses, Protections, protectionRules } from '../src/protections.js';
import { OwnerDigest } from '../src/owner-digest.js';
import { TradeSignals, RULES_VERSION } from '../src/trade-signals.js';
import { PaperPerformance } from '../src/paper-performance.js';

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

    // CHARTER-01 last-resort stop: total P&L (realised and open) against the charter's limit; it halts once, never lifts itself
    assert.equal((await protections.guard(evaluator, key())).status, 'no-limit');
    await protections.setPolicy(owner, key(), { rules: { organisationLossPaise: '1000000' }, reason: 'Charter: Rs 10,000 at most' });
    assert.equal((await protections.guard(evaluator, key())).status, 'within');
    await protections.setPolicy(owner, key(), { rules: { organisationLossPaise: '1000' }, reason: 'Charter: a tight limit for the test' });
    const stopped = await protections.guard(evaluator, key());
    assert.equal(stopped.status, 'stopped');                                       // the losing exits put it past Rs 10
    const halted = (await f.db.transaction(tx => tx.query('SELECT halted FROM system_lock WHERE id=1'), false)).rows[0]!.halted;
    assert.equal(halted, true);
    assert.equal((await f.db.transaction(tx => tx.query("SELECT severity,status FROM incidents WHERE id=$1", [stopped.incidentId]), false)).rows[0]!.severity, 'critical');
    assert.equal((await protections.guard(evaluator, key())).status, 'already-halted'); // one incident, not one a day
    await assert.rejects(() => f.paper.reserve(trader, key(), { botId: 'bot-one', symbol: 'OTHER', side: 'buy', quantity: 1, evidenceId: e.evidenceId }), /halted/);
    await f.db.transaction(tx => tx.query('UPDATE system_lock SET halted=false WHERE id=1'));       // (the owner's resume, simplified)
    await protections.setPolicy(owner, key(), { rules: {}, reason: 'Back to no limit' });

    // the digest says whether brakes are set and who is paused
    const d = await new OwnerDigest(f.db, f.cfg).digest(owner, {});
    assert.deepEqual(d.protections, { policySet: true, paused: [] });
    assert.throws(() => protections.status(trader, {}));
  } finally { await f.db.close(); }
});

test('equity brakes pause new buys during a fall in open positions, with no sale, and lift once the fall stops', async () => {
  const f = await fixture();
  try {
    const e = await f.evidence(); await f.deposit('500000');
    await f.org.bot(owner, key(), { id: 'bot-one', name: 'Fixture', department: 'research', specialty: 'demo', method: 'test', contribution: 'Protection fixture', budgetPaise: '1000000' });
    await f.db.transaction(tx => tx.query("UPDATE bots SET state='paper' WHERE id='bot-one'"));
    const quote = (paise: string) => f.paper.quote(market, key(), { symbol: 'DEMO', bidPaise: paise, askPaise: paise, observedAt: new Date().toISOString(), sourceId: e.sourceId });
    await quote('10000');
    const o = await f.paper.reserve(trader, key(), { botId: 'bot-one', symbol: 'DEMO', side: 'buy', quantity: 20, evidenceId: e.evidenceId });
    await f.paper.fill(trader, key(), { orderId: o.id });
    const protections = new Protections(f.db);
    const pauses = (now = Date.now()) => f.db.transaction(tx => activePauses(tx, 'bot-one', null, now), false);

    // a 6% fall on 20 shares: 12,000 paise, 1.2% of the budget, all of it open
    await quote('9400');
    await protections.setPolicy(owner, key(), { rules: { dailyLossPct: 1 }, reason: 'Realised brakes' });
    assert.deepEqual(await pauses(), []);                                   // nothing was sold, so realised brakes see nothing
    await protections.setPolicy(owner, key(), { rules: { dailyLossPct: 1, measure: 'equity' }, reason: 'Equity brakes' });
    const [pause] = await pauses();
    assert.equal(pause!.code, 'protection-daily-loss');
    assert.match(pause!.detail, /fall in value \(open positions included\)/);
    // today's mark is recorded; a day later, with no further fall, the daily window measures from that mark and lifts
    await new PaperPerformance(f.db).snapshot(evaluator, key());
    assert.deepEqual(await pauses(Date.now() + 1.5 * DAY), []);
  } finally { await f.db.close(); }
});

test('a sector limit sizes a buy down to the room left in its sector; other sectors and exits are untouched', async () => {
  const f = await fixture();
  try {
    const e = await f.evidence(); await f.deposit('2000000');
    await f.org.bot(owner, key(), { id: 'bot-one', name: 'Fixture', department: 'research', specialty: 'demo', method: 'test', contribution: 'Sector fixture', budgetPaise: '1000000' });
    await f.db.transaction(tx => tx.query("UPDATE bots SET state='paper' WHERE id='bot-one'"));
    for (const s of ['BANKA', 'BANKB', 'BANKC', 'TECH'])
      await f.paper.quote(market, key(), { symbol: s, bidPaise: '10000', askPaise: '10000', observedAt: new Date().toISOString(), sourceId: e.sourceId });
    // 40% of the Rs 10,000 budget already in one bank
    const held = await f.paper.reserve(trader, key(), { botId: 'bot-one', symbol: 'BANKA', side: 'buy', quantity: 40, evidenceId: e.evidenceId });
    await f.paper.fill(trader, key(), { orderId: held.id });
    const signals = new TradeSignals(f.db, f.cfg), protections = new Protections(f.db);
    const buy = async (symbol: string) => signals.review(evaluator, key(), { signalId: (await signals.propose(trader, key(), { botId: 'bot-one', symbol,
      action: 'enter-long', horizonDays: 30, conviction: 'high', targetWeightPct: 33, thesis: 't', invalidation: 'i',
      expiresAt: new Date(Date.now() + DAY).toISOString(), evidenceIds: [e.evidenceId] })).id });
    const sectors = { BANKA: 'Financial Services', BANKB: 'Financial Services', BANKC: 'Financial Services', TECH: 'Information Technology' };
    assert.throws(() => protections.setPolicy(owner, key(), { rules: { sectorLimit: { maxPct: 2, sectors } }, reason: 'too tight' }));
    await protections.setPolicy(owner, key(), { rules: { sectorLimit: { maxPct: 50, sectors } }, reason: 'At most half in one sector' });
    // a second bank fits only the 10% left in the sector (Rs 1,000: 10 shares), not its 33% target
    const bank = await buy('BANKB');
    assert.equal(bank.outcome, 'accepted');
    assert.equal(bank.quantity, '10');
    assert.ok(bank.reasons.includes('sized-by-sector-limit'), bank.reasons.join());
    // another sector is sized by its own target, as before
    const tech = await buy('TECH');
    assert.equal(tech.quantity, '33');
    assert.ok(tech.reasons.includes('sized-by-target-weight'));
    // the suggested founder files are valid policies as written
    for (const file of ['protections-suggested.json', 'protections-with-sectors.json'])
      protectionRules.parse(JSON.parse(readFileSync(join('docs', 'policies', file), 'utf8')).rules);
    // the accepted bank intent counts too: a third bank finds no room left in the sector at all
    const full = await buy('BANKC');
    assert.equal(full.outcome, 'rejected');
    assert.ok(full.reasons.includes('size-below-one-share') && full.reasons.includes('sector-limit'), full.reasons.join());
  } finally { await f.db.close(); }
});
