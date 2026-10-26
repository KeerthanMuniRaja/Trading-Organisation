import test from 'node:test';
import assert from 'node:assert/strict';
import { owner,researcher,evaluator,trader,market,treasuryActor,fixture,key,bars } from './helpers.js';
import { paperFee } from '../src/config.js';

test('fills revalidate current limits and nonzero execution costs reconcile through partial exits',async()=>{
  const f=await fixture();
  try{
    const e=await f.evidence();await f.deposit('100000');f.cfg.feeBps=10;f.cfg.slippageBps=5;
    await f.org.bot(owner,key(),{id:'bot-one',name:'Fixture',department:'research',specialty:'costs',method:'test',contribution:'Cost accounting fixture',budgetPaise:'100000'});
    await f.db.transaction(tx=>tx.query("UPDATE bots SET state='paper' WHERE id='bot-one'"));
    await f.paper.quote(market,key(),{symbol:'COST',bidPaise:'10000',askPaise:'10000',observedAt:new Date().toISOString(),sourceId:e.sourceId});
    const buy=await f.paper.reserve(trader,key(),{botId:'bot-one',symbol:'COST',side:'buy',quantity:2,evidenceId:e.evidenceId});
    f.cfg.maxOrder=10000n;await assert.rejects(()=>f.paper.fill(trader,key(),{orderId:buy.id}),/current configured limit/);
    f.cfg.maxOrder=100000n;f.cfg.maxExposure=10000n;await assert.rejects(()=>f.paper.fill(trader,key(),{orderId:buy.id}),/Current organisation exposure/);
    f.cfg.maxExposure=100000n;await f.db.transaction(tx=>tx.query("UPDATE bots SET budget_paise=10000 WHERE id='bot-one'"));
    await assert.rejects(()=>f.paper.fill(trader,key(),{orderId:buy.id}),/Current bot budget/);
    await f.db.transaction(tx=>tx.query("UPDATE bots SET budget_paise=100000 WHERE id='bot-one'"));
    const fill=await f.paper.fill(trader,key(),{orderId:buy.id});assert.equal(fill.pricePaise,'10005');assert.equal(fill.feePaise,'21');
    await f.paper.quote(market,key(),{symbol:'COST',bidPaise:'11000',askPaise:'11000',observedAt:new Date().toISOString(),sourceId:e.sourceId});
    for(let i=0;i<2;i++){
      const sell=await f.paper.reserve(trader,key(),{botId:'bot-one',symbol:'COST',side:'sell',quantity:1,evidenceId:e.evidenceId});const sold=await f.paper.fill(trader,key(),{orderId:sell.id});assert.equal(sold.pricePaise,'10994');assert.equal(sold.feePaise,'11');
      if(i===0){const partial=await f.treasury.snapshot(owner);assert.equal(partial.positionCostPaise,'10005');assert.equal(partial.realisedNetProfitPaise,'957');}
    }
    const result=await f.treasury.snapshot(owner);assert.equal(result.realisedNetProfitPaise,'1935');assert.equal(result.wallet1Paise,'101935');
    const allocation=await f.treasury.allocate(treasuryActor,key());assert.equal(allocation.protectedPaise,'774');
  }finally{await f.db.close();}
});

test('NSE delivery charges: statutory costs on both sides and the fixed depository charge on each sale, as the research desk models them',async()=>{
  // the research desk's own vectors (integrations/trading-desk/test_daily.py): Rs 1,00,000 bought, then sold
  const nse={feeBps:10,costModel:'nse-delivery' as const};
  assert.equal(paperFee(nse,'buy',10_000_000n),11_863n);assert.equal(paperFee(nse,'sell',10_000_000n),11_956n);
  assert.equal(paperFee({feeBps:10,costModel:'flat'},'sell',10_000_000n),10_000n); // the original flat model is unchanged
  const f=await fixture();
  try{
    const e=await f.evidence();await f.deposit('100000');f.cfg.slippageBps=5;f.cfg.costModel='nse-delivery';
    await f.org.bot(owner,key(),{id:'bot-one',name:'Fixture',department:'research',specialty:'costs',method:'test',contribution:'Cost accounting fixture',budgetPaise:'100000'});
    await f.db.transaction(tx=>tx.query("UPDATE bots SET state='paper' WHERE id='bot-one'"));
    await f.paper.quote(market,key(),{symbol:'COST',bidPaise:'10000',askPaise:'10000',observedAt:new Date().toISOString(),sourceId:e.sourceId});
    const buy=await f.paper.reserve(trader,key(),{botId:'bot-one',symbol:'COST',side:'buy',quantity:2,evidenceId:e.evidenceId});
    const fill=await f.paper.fill(trader,key(),{orderId:buy.id});assert.equal(fill.feePaise,'24'); // Rs 200.10 bought: 0.119%
    await f.paper.quote(market,key(),{symbol:'COST',bidPaise:'11000',askPaise:'11000',observedAt:new Date().toISOString(),sourceId:e.sourceId});
    for(let i=0;i<2;i++){
      const sell=await f.paper.reserve(trader,key(),{botId:'bot-one',symbol:'COST',side:'sell',quantity:1,evidenceId:e.evidenceId});
      assert.equal((await f.paper.fill(trader,key(),{orderId:sell.id})).feePaise,'1605'); // Rs 0.12 statutory + Rs 15.93 DP on a Rs 109.94 sale
    }
    // the same trades that made Rs 19.35 under a flat 10 bps lose Rs 12.56: on small sales the DP charge decides
    assert.equal((await f.treasury.snapshot(owner)).realisedNetProfitPaise,'-1256');
  }finally{await f.db.close();}
});

test('revoking evidence invalidates learning, leased research and pending execution without starving valid jobs',async()=>{
  const f=await fixture();
  try{
    const bad=await f.evidence(),good=await f.evidence();await f.deposit('100000');
    await f.org.bot(owner,key(),{id:'bot-one',name:'Fixture',department:'research',specialty:'revocation',method:'test',contribution:'Revocation fixture',budgetPaise:'100000'});
    const lesson=await f.org.lesson(researcher,key(),{botId:'bot-one',content:'A lesson later found to have unreliable support',evidenceId:bad.evidenceId});await f.org.verifyLesson(evaluator,key(),{lessonId:lesson.id});await f.org.school(owner,key(),{botId:'bot-one',lessonIds:[lesson.id]});
    const dataset=await f.research.dataset(owner,key(),{evidenceId:bad.evidenceId,training:bars(30,10000),holdout:bars(30,13000,30)});
    await f.research.experiment(researcher,key(),{botId:'bot-one',datasetId:dataset.id,hypothesis:'Unreliable data fixture'});
    const job=(await f.research.claim(researcher)).job!;const repeated=(await f.research.claim(researcher)).job!;assert.equal(job.id,repeated.id);assert.equal(job.leaseToken,repeated.leaseToken);
    await f.db.transaction(tx=>tx.query("UPDATE bots SET state='paper' WHERE id='bot-one'"));
    await f.paper.quote(market,key(),{symbol:'REV',bidPaise:'10000',askPaise:'10000',observedAt:new Date().toISOString(),sourceId:good.sourceId});
    const order=await f.paper.reserve(trader,key(),{botId:'bot-one',symbol:'REV',side:'buy',quantity:1,evidenceId:bad.evidenceId});
    await f.org.revoke(evaluator,key(),{kind:'evidence',targetId:bad.evidenceId,reason:'Independent review found a source error'});
    await assert.rejects(()=>f.paper.fill(trader,key(),{orderId:order.id}),/Verified evidence/);
    await assert.rejects(()=>f.paper.reserve(trader,key(),{botId:'bot-one',symbol:'REV',side:'buy',quantity:1,evidenceId:good.evidenceId}),/Qualification evidence/);
    await assert.rejects(()=>f.research.complete(researcher,key(),{jobId:job.id,leaseToken:job.leaseToken,result:{candidate:{kind:'momentum',lookback:2},trainingReport:{selectedScoreBps:1,trials:[{lookback:2,netReturnBps:1}]}}}),/lease is not valid/);
    const knowledge=await f.org.knowledge(researcher);assert.ok(!knowledge.evidence.some(e=>e.id===bad.evidenceId));assert.ok(!knowledge.lessons.some(l=>l.id===lesson.id));
    await f.db.transaction(tx=>tx.query("UPDATE bots SET state='college' WHERE id='bot-one'"));
    const fresh=await f.research.dataset(owner,key(),{evidenceId:good.evidenceId,training:bars(30,10000),holdout:bars(30,13000,30)});
    await f.research.experiment(researcher,key(),{botId:'bot-one',datasetId:fresh.id,hypothesis:'Fresh independent source'});
    const next=(await f.research.claim(researcher)).job!;assert.notEqual(next.id,job.id);
    await f.org.revoke(owner,key(),{kind:'source',targetId:good.sourceId,reason:'Suspend provider'});
    assert.equal((await f.research.claim(researcher)).job,null);assert.equal((await f.org.knowledge(researcher)).evidence.length,0);
  }finally{await f.db.close();}
});
