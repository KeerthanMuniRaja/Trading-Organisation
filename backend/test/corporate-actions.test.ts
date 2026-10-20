import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, config, owner, researcher, evaluator, trader, key } from './helpers.js';
import { CorporateActions } from '../src/corporate-actions.js';
import { TradeSignals } from '../src/trade-signals.js';
import { Database } from '../src/database.js';
import { createApp } from '../src/app.js';

const says = (pattern: RegExp) => (error: any) => pattern.test(JSON.stringify(error?.getResponse?.() ?? error?.message));
const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

async function setup() {
  const f = await fixture();
  const e = await f.evidence();
  for (const id of ['bot-one', 'bot-two']) {
    await f.org.bot(owner, key(), { id, name: id, department: 'desk', specialty: id, method: 'test', contribution: 'Corporate action fixture', budgetPaise: '1000000' });
    await f.db.transaction(tx => tx.query("UPDATE bots SET state='paper' WHERE id=$1", [id]));
  }
  const notice = async (content: string) => {
    const id = (await f.org.evidence(researcher, key(), { sourceId: e.sourceId, kind: 'filing', content, publishedAt: new Date(Date.now() - 86_400_000).toISOString() })).id as string;
    await f.org.reviewEvidence(evaluator, key(), { evidenceId: id, status: 'verified' });
    return id;
  };
  // a verified daily close in the strict form scoring requires (PAPER-04), observed now
  const close = async (symbol: string, price: string) => {
    const at = new Date(Date.now() - 1000).toISOString(), day = new Date(Date.parse(at) + 330 * 60_000).toISOString().slice(0, 10);
    const id = (await f.org.evidence(researcher, key(), { sourceId: e.sourceId, kind: 'dataset', content: `Daily close of NSE:${symbol} on ${day}: ${price} paise.`, publishedAt: at })).id as string;
    await f.org.reviewEvidence(evaluator, key(), { evidenceId: id, status: 'verified' });
    return { evidenceId: id, exitPricePaise: price, observedAt: at };
  };
  return { ...f, e, notice, close, actions: new CorporateActions(f.db) };
}

test('a bonus issue rescales every open position once, keeping its cost, and is append-only', async () => {
  const f = await setup(); try {
    await f.db.transaction(async tx => {
      await tx.query("INSERT INTO positions VALUES('bot-one','DEMO',10,100000),('bot-two','DEMO',7,70700),('bot-one','OTHER',5,5000)");
    });
    const evidence = await f.notice('NSE:DEMO bonus issue 1:1 (one new share for every share held), ex-date today.');
    assert.throws(() => f.actions.record(trader, key(), { symbol: 'DEMO', kind: 'bonus', sharesBefore: 1, sharesAfter: 2, exDate: today(), evidenceId: evidence }));
    assert.throws(() => f.actions.record(owner, key(), { symbol: 'DEMO', kind: 'bonus', sharesBefore: 1, sharesAfter: 2, exDate: '2099-01-01', evidenceId: evidence }), says(/on or after its ex-date/));
    await assert.rejects(() => f.actions.record(owner, key(), { symbol: 'OTHER', kind: 'bonus', sharesBefore: 1, sharesAfter: 2, exDate: today(), evidenceId: evidence }), says(/does not name this share/));

    const done = await f.actions.record(owner, key(), { symbol: 'DEMO', kind: 'bonus', sharesBefore: 1, sharesAfter: 2, exDate: today(), evidenceId: evidence });
    assert.deepEqual(done.adjusted, [{ botId: 'bot-one', quantityBefore: '10', quantityAfter: '20' }, { botId: 'bot-two', quantityBefore: '7', quantityAfter: '14' }]);
    const rows = (await f.db.transaction(tx => tx.query('SELECT bot_id,symbol,quantity::text AS q,cost_paise::text AS c FROM positions ORDER BY bot_id,symbol'))).rows;
    assert.deepEqual(rows.map(r => [r.bot_id, r.symbol, r.q, r.c]), [['bot-one', 'DEMO', '20', '100000'], ['bot-one', 'OTHER', '5', '5000'], ['bot-two', 'DEMO', '14', '70700']]);
    await assert.rejects(() => f.actions.record(owner, key(), { symbol: 'DEMO', kind: 'bonus', sharesBefore: 1, sharesAfter: 2, exDate: today(), evidenceId: evidence }), says(/already recorded/));
    assert.equal((await f.actions.list(trader)).actions[0]!.adjusted.length, 2);
    await assert.rejects(() => f.db.transaction(tx => tx.query('DELETE FROM corporate_action_adjustments')));
    assert.equal((await f.ops.verifyAudit(owner)).valid, true);
  } finally { await f.db.close(); }
});

test('fractional entitlements and open reservations are refused, to be settled by hand', async () => {
  const f = await setup(); try {
    await f.db.transaction(async tx => {
      await tx.query("INSERT INTO positions VALUES('bot-one','ODD',3,30000)");
      await tx.query("INSERT INTO orders(id,bot_id,symbol,side,quantity,reserved_paise,evidence_id,status) VALUES($1,'bot-two','HELD','buy',2,20000,$2,'reserved')", [crypto.randomUUID(), f.e.evidenceId]);
    });
    const odd = await f.notice('NSE:ODD bonus issue 1:2 (one new share for every two held).');
    await assert.rejects(() => f.actions.record(owner, key(), { symbol: 'ODD', kind: 'bonus', sharesBefore: 2, sharesAfter: 3, exDate: today(), evidenceId: odd }), says(/Fractional entitlement for bot-one/));
    const held = await f.notice('NSE:HELD split from face value 10 to 2.');
    await assert.rejects(() => f.actions.record(owner, key(), { symbol: 'HELD', kind: 'split', sharesBefore: 1, sharesAfter: 5, exDate: today(), evidenceId: held }), says(/open reservations/));
    assert.throws(() => f.actions.record(owner, key(), { symbol: 'ODD', kind: 'split', sharesBefore: 2, sharesAfter: 2, exDate: today(), evidenceId: odd }));
  } finally { await f.db.close(); }
});

test('a call reviewed before the ex-date is scored on the same basis as its exit price', async () => {
  const f = await setup(); try {
    const signals = new TradeSignals(f.db, f.cfg);
    const reviewed = async (symbol: string) => {
      const id = crypto.randomUUID();
      await f.db.transaction(async tx => {
        await tx.query(`INSERT INTO trade_signals(id,bot_id,symbol,action,horizon_days,conviction,thesis,invalidation,expires_at,author,content_hash,created_at)
          VALUES($1,'bot-one',$2,'enter-long',30,'medium','Fixture','Fixture',now()-interval '35 days','trader',$3,now()-interval '40 days')`, [id, symbol, 'hash-' + id]);
        await tx.query(`INSERT INTO trade_signal_reviews(id,signal_id,outcome,reasons,side,quantity,reference_price_paise,rules_version,reviewer,created_at)
          VALUES($1,$2,'accepted',ARRAY['fixture']::text[],'buy',10,10000,'signal-risk-v2','evaluator',now()-interval '39 days')`, [crypto.randomUUID(), id]);
      });
      return id;
    };
    const split = await reviewed('DEMO'), plain = await reviewed('OTHER');
    await f.actions.record(owner, key(), { symbol: 'DEMO', kind: 'bonus', sharesBefore: 1, sharesAfter: 2, exDate: today(),
      evidenceId: await f.notice('NSE:DEMO bonus issue 1:1, ex-date today.') });
    // DEMO now trades at 5500 after the 1:1 bonus: on the same basis the reference is 5000, so the call gained 10%
    const scored = await signals.outcome(evaluator, key(), { signalId: split, ...await f.close('DEMO', '5500') });
    assert.deepEqual([scored.moveBps, scored.correct], [1000, true]);
    const untouched = await signals.outcome(evaluator, key(), { signalId: plain, ...await f.close('OTHER', '5500') });
    assert.deepEqual([untouched.moveBps, untouched.correct], [-4500, false]); // no action on OTHER: a real fall
    // the exit price must be the one its evidence states: a different price, or a re-dated observation, is refused
    const other = await reviewed('DEMO'), real = await f.close('DEMO', '5600');
    await assert.rejects(() => signals.outcome(evaluator, key(), { signalId: other, ...real, exitPricePaise: '9999' }), says(/does not state this price/));
    await assert.rejects(() => signals.outcome(evaluator, key(), { signalId: other, ...real, observedAt: new Date().toISOString() }), says(/own publication time/));
  } finally { await f.db.close(); }
});

test('a dividend pays holders on the ex-date as realised profit, and calls held through it are scored on total return', async () => {
  const f = await setup(); try {
    // bot-one holds 10 DEMO now, after selling 5 today (so it held 15 through the ex-date); bot-two bought its 4 today (not entitled)
    await f.db.transaction(async tx => {
      await tx.query("INSERT INTO positions VALUES('bot-one','DEMO',10,100000),('bot-two','DEMO',4,40000)");
      for (const [bot, side, qty] of [['bot-one', 'sell', 5], ['bot-two', 'buy', 4], ['bot-one', 'buy', 15]] as const) {
        const order = crypto.randomUUID(), journal = crypto.randomUUID();
        await tx.query("INSERT INTO journals(id,kind,reference,metadata) VALUES($1,'fixture',$2,'{}'::jsonb)", [journal, 'fixture-' + journal]);
        await tx.query("INSERT INTO orders(id,bot_id,symbol,side,quantity,reserved_paise,evidence_id,status) VALUES($1,$2,'DEMO',$3,$4,0,$5,'filled')", [order, bot, side, qty, f.e.evidenceId]);
        await tx.query(`INSERT INTO fills(id,order_id,price_paise,quantity,fee_paise,journal_id,created_at) VALUES($1,$2,10000,$3,0,$4,${qty === 15 ? "now()-interval '20 days'" : 'now()'})`,
          [crypto.randomUUID(), order, qty, journal]);
      }
    });
    const notice = await f.notice('NSE:DEMO final dividend of Rs 10 per share, ex-date today.');
    await assert.rejects(() => f.actions.dividend(owner, key(), { symbol: 'OTHER', amountPerSharePaise: '1000', exDate: today(), evidenceId: notice }), says(/does not name this share/));
    assert.throws(() => f.actions.dividend(evaluator, key(), { symbol: 'DEMO', amountPerSharePaise: '1000', exDate: today(), evidenceId: notice }));
    const paid = await f.actions.dividend(owner, key(), { symbol: 'DEMO', amountPerSharePaise: '1000', exDate: today(), evidenceId: notice });
    assert.deepEqual(paid.paid, [{ botId: 'bot-one', shares: '15', amountPaise: '15000' }]);
    await assert.rejects(() => f.actions.dividend(owner, key(), { symbol: 'DEMO', amountPerSharePaise: '1000', exDate: today(), evidenceId: notice }), says(/already recorded/));
    const { PaperPerformance } = await import('../src/paper-performance.js');
    const one = (await new PaperPerformance(f.db).report(owner)).bots.find(b => b.botId === 'bot-one')!;
    assert.equal(one.realisedPaise, '15000'); // the dividend is realised paper profit
    assert.equal((await f.actions.list(trader)).dividends[0]!.paid.length, 1);

    // a long reviewed at 10000 before the ex-date, now 9600 after a 500 dividend: total return +1.05%, not -4%
    const signals = new TradeSignals(f.db, f.cfg), id = crypto.randomUUID();
    await f.db.transaction(async tx => {
      await tx.query(`INSERT INTO trade_signals(id,bot_id,symbol,action,horizon_days,conviction,thesis,invalidation,expires_at,author,content_hash,created_at)
        VALUES($1,'bot-one','DIV','enter-long',30,'medium','Fixture','Fixture',now()-interval '35 days','trader',$2,now()-interval '40 days')`, [id, 'hash-' + id]);
      await tx.query(`INSERT INTO trade_signal_reviews(id,signal_id,outcome,reasons,side,quantity,reference_price_paise,rules_version,reviewer,created_at)
        VALUES($1,$2,'accepted',ARRAY['fixture']::text[],'buy',10,10000,'signal-risk-v2','evaluator',now()-interval '39 days')`, [crypto.randomUUID(), id]);
    });
    await f.actions.dividend(owner, key(), { symbol: 'DIV', amountPerSharePaise: '500', exDate: today(), evidenceId: await f.notice('NSE:DIV interim dividend of Rs 5.') });
    const scored = await signals.outcome(evaluator, key(), { signalId: id, ...await f.close('DIV', '9600') });
    assert.deepEqual([scored.moveBps, scored.correct], [105, true]);
    assert.equal((await f.ops.verifyAudit(owner)).valid, true);
  } finally { await f.db.close(); }
});

test('corporate action routes: the owner records, everyone may read', async () => {
  const { cfg } = config(), db = await Database.open(), app = await createApp(cfg, db, true);
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const call = (method: string, role: string, body?: unknown) => fetch(base + '/v1/corporate-actions', { method, ...(body ? { body: JSON.stringify(body) } : {}),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key(), Authorization: 'Bearer ' + cfg.principals.find(p => p.role === role)!.token } });
    assert.equal((await call('GET', 'trader')).status, 200);
    assert.equal((await call('POST', 'evaluator', {})).status, 403);
  } finally { await app.close(); await db.close(); }
});
