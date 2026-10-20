import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, config, owner, researcher, evaluator, trader, market, key } from './helpers.js';
import { OwnerDigest } from '../src/owner-digest.js';
import { TradeSignals } from '../src/trade-signals.js';
import { Database } from '../src/database.js';
import { createApp } from '../src/app.js';

test('the digest summarises money, trading, knowledge and what needs the owner', async () => {
  const f = await fixture(); try {
    const e = await f.evidence();
    await f.deposit('500000');
    await f.org.bot(owner, key(), { id: 'bot-one', name: 'bot-one', department: 'desk', specialty: 'one', method: 'test', contribution: 'Digest fixture', budgetPaise: '1000000' });
    await f.db.transaction(tx => tx.query("UPDATE bots SET state='paper' WHERE id='bot-one'"));
    await f.paper.quote(market, key(), { symbol: 'DEMO', bidPaise: '10000', askPaise: '10000', observedAt: new Date().toISOString(), sourceId: e.sourceId });
    const signals = new TradeSignals(f.db, f.cfg);
    const base = { botId: 'bot-one', symbol: 'DEMO', horizonDays: 5, conviction: 'medium', thesis: 't', invalidation: 'i',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(), evidenceIds: [e.evidenceId] };
    const buy = await signals.propose(trader, key(), { ...base, action: 'enter-long' });
    await signals.review(evaluator, key(), { signalId: buy.id });
    await signals.execute(trader, key(), { signalId: buy.id });
    await f.paper.quote(market, key(), { symbol: 'DEMO', bidPaise: '10400', askPaise: '10400', observedAt: new Date(Date.now() + 1000).toISOString(), sourceId: e.sourceId });
    await f.org.evidence(researcher, key(), { sourceId: e.sourceId, kind: 'news', content: 'Unreviewed ' + key(), publishedAt: new Date().toISOString() });
    await f.db.transaction(tx => tx.query("UPDATE system_lock SET halted=true WHERE id=1"));

    const d = await new OwnerDigest(f.db).digest(owner, {});
    assert.deepEqual([d.trading.proposed, d.trading.accepted, d.trading.executed], [1, 1, 1]);
    assert.equal(d.money.unrealisedPaise, '10000'); // 25 shares marked 400 paise above cost
    assert.equal(d.knowledge.backlog, 1);
    assert.deepEqual([d.trading.lapsed, d.trading.releasedPaise, d.trading.corporateActions, d.money.stalePositions, d.liveFitness], [0, '0', 0, 0, []]);
    assert.deepEqual(d.organisation, { suspendedBots: [], departmentsActive: 0, departmentsClosed: 0, hackathonsOpen: 0, hackathonsJudging: 0 });
    assert.equal(d.halted, true);
    assert.equal(d.needsOwner[0], 'New risk is HALTED.');
    assert.throws(() => new OwnerDigest(f.db).digest(trader, {}));
  } finally { await f.db.close(); }
});

test('the digest route is owner and evaluator only', async () => {
  const { cfg } = config(), db = await Database.open(), app = await createApp(cfg, db, true);
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const post = (role: string) => fetch(base + '/v1/owner/digest', { method: 'POST', body: '{}',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.principals.find(p => p.role === role)!.token } });
    assert.equal((await post('evaluator')).status, 201);
    assert.equal((await post('researcher')).status, 403);
  } finally { await app.close(); await db.close(); }
});
