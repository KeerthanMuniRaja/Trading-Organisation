import test from 'node:test';
import assert from 'node:assert/strict';
import { owner,trader,treasuryActor,market,fixture,key } from './helpers.js';

test('paper execution enforces shared capital, position accounting, and incident containment',async t=>{
  const f=await fixture();
  try {
    const e=await f.evidence();await f.deposit('150000');
    await f.org.bot(owner,key(),{id:'bot-one',name:'Fixture',department:'research',specialty:'demo',method:'test',contribution:'Execution fixture',budgetPaise:'1000000'});
    // Isolate execution invariants from the separately tested academy.
    await f.db.transaction(tx=>tx.query("UPDATE bots SET state='paper' WHERE id='bot-one'"));
    await f.paper.quote(market,key(),{symbol:'DEMO',bidPaise:'10000',askPaise:'10000',observedAt:new Date().toISOString(),sourceId:e.sourceId});
    let orderId='';
    await t.test('concurrent reservations cannot spend the same funds',async()=>{
      const request={botId:'bot-one',symbol:'DEMO',side:'buy',quantity:10,evidenceId:e.evidenceId};
      const results=await Promise.allSettled([f.paper.reserve(trader,key(),request),f.paper.reserve(trader,key(),request)]);
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
      orderId=(results.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<{id:string}>).value.id;
      assert.equal((await f.treasury.snapshot(owner)).availablePaise,'50000');
    });
    await t.test('fill consumes one reservation and produces balanced accounting',async()=>{
      const k=key();await f.paper.fill(trader,k,{orderId});await f.paper.fill(trader,k,{orderId});
      const s=await f.treasury.snapshot(owner);assert.equal(s.wallet1Paise,'50000');assert.equal(s.positionCostPaise,'100000');assert.equal(s.availablePaise,'50000');
      await assert.rejects(()=>f.treasury.allocate(treasuryActor,key()),/Close paper positions/);
    });
    await t.test('partial sales preserve cost basis and cannot oversell',async()=>{
      await f.paper.quote(market,key(),{symbol:'DEMO',bidPaise:'11000',askPaise:'11000',observedAt:new Date().toISOString(),sourceId:e.sourceId});
      const sell=await f.paper.reserve(trader,key(),{botId:'bot-one',symbol:'DEMO',side:'sell',quantity:4,evidenceId:e.evidenceId});await f.paper.fill(trader,key(),{orderId:sell.id});
      const s=await f.treasury.snapshot(owner);assert.equal(s.positionCostPaise,'60000');assert.equal(s.realisedNetProfitPaise,'4000');
      await assert.rejects(()=>f.paper.reserve(trader,key(),{botId:'bot-one',symbol:'DEMO',side:'sell',quantity:7,evidenceId:e.evidenceId}),/Insufficient unreserved/);
    });
    await t.test('critical incident blocks new risk but permits orderly exits',async()=>{
      const incident=await f.ops.incident(trader,key(),{description:'Simulated feed integrity failure',severity:'critical'});
      await assert.rejects(()=>f.paper.reserve(trader,key(),{botId:'bot-one',symbol:'DEMO',side:'buy',quantity:1,evidenceId:e.evidenceId}),/halted/);
      const sell=await f.paper.reserve(trader,key(),{botId:'bot-one',symbol:'DEMO',side:'sell',quantity:6,evidenceId:e.evidenceId});await f.paper.fill(trader,key(),{orderId:sell.id});
      await assert.rejects(()=>f.ops.control(owner,key(),{halted:false,reason:'Premature resume'}),/Resolve critical/);
      await f.ops.resolve(owner,key(),{incidentId:incident.id,evidenceId:e.evidenceId});await f.ops.control(owner,key(),{halted:false,reason:'Verified paper recovery'});
      assert.equal((await f.treasury.snapshot(owner)).realisedNetProfitPaise,'10000');
    });
    await t.test('stale quotes and cross-bot credential use are rejected',async()=>{
      await f.db.transaction(tx=>tx.query("UPDATE quotes SET observed_at=now()-interval '2 minutes'"));
      await assert.rejects(()=>f.paper.reserve(trader,key(),{botId:'bot-one',symbol:'DEMO',side:'buy',quantity:1,evidenceId:e.evidenceId}),/Fresh approved/);
      await assert.rejects(()=>f.paper.reserve(trader,key(),{botId:'other-bot',symbol:'DEMO',side:'buy',quantity:1,evidenceId:e.evidenceId}),/bound to another/);
    });
  } finally {await f.db.close();}
});
