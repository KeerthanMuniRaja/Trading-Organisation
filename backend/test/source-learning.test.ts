import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,owner,researcher,evaluator,key } from './helpers.js';
import { SourceLearning } from '../src/source-learning.js';
import { ResearchDevelopment } from '../src/development.js';
import { BotKnowledge } from '../src/bot-knowledge.js';
import { createApp } from '../src/app.js';
async function setup(){
  const f=await fixture(),service=new SourceLearning(f.db),dev=new ResearchDevelopment(f.db);
  for(const bot of ['mentor','student'])await f.org.bot(owner,key(),{id:bot,name:bot,department:'research',specialty:bot,method:'reasoning',contribution:'Role '+bot,budgetPaise:'0'});
  await f.org.sources(owner,key(),{id:'publisher',name:'Fixture',url:'https://example.org',approved:true});
  const e=await f.org.observations().ingest(researcher,key(),{sourceId:'publisher',url:'https://example.org/story',title:'Cost example',kind:'article',content:'Fees and slippage reduce net returns. Historical outcomes may not generalise.',publishedAt:'2025-01-01T00:00:00Z'});
  await f.org.reviewEvidence(evaluator,key(),{evidenceId:e.id,status:'verified'});
  await dev.configure(owner,key(),{expectedRevision:0,enabled:true,model:{name:'fixture',baseUrl:'http://127.0.0.1:8000/v1'},maxPerDay:4,maxLifetime:4});
  return {...f,service,dev,input:{botId:'mentor',evidenceId:e.id},proposal:{lesson:'Evaluate net rather than gross returns.',quote:'Fees and slippage reduce net returns.',limitation:'A general principle is not evidence of profitable performance.'}};
}
test('cited source lesson requires dedicated independent review before cross-bot reuse',async()=>{
  const f=await setup();try{
    const t=await f.service.request(researcher,key(),f.input);await f.service.preflight(researcher,{requestId:t.id});
    const body={requestId:t.id,contextHash:t.contextHash,proposal:f.proposal},command=key();
    const p=await f.service.submit(researcher,command,body);assert.deepEqual(await f.service.submit(researcher,command,body),p);
    await assert.rejects(()=>f.org.verifyLesson(evaluator,key(),{lessonId:p.lessonId}),/dedicated/);
    const k=new BotKnowledge(f.db),transfer={botId:'student',task:'Apply the source lesson',lessonIds:[p.lessonId]};
    await assert.rejects(()=>k.request(researcher,key(),transfer),/verified/);
    await assert.rejects(()=>f.service.review({...evaluator,id:researcher.id},key(),{requestId:t.id,decision:'accepted',reason:'Self review'}),/Independent/);
    await f.service.review(evaluator,key(),{requestId:t.id,decision:'accepted',reason:'Quotation supports the bounded lesson; uncertainty preserved'});
    await k.request(researcher,key(),transfer);
    const graph=await k.graph(owner,{botId:'student'});assert.ok(graph.edges.some(e=>e.type==='extracted-through'));
    assert.ok((await f.org.knowledge(owner)).lessons.some(l=>l.id===p.lessonId));
    for(const table of ['source_learning_requests','source_learning_proposals','source_learning_reviews'])await assert.rejects(()=>f.db.transaction(tx=>tx.query('DELETE FROM '+table)));
    assert.equal((await f.ops.verifyAudit(owner)).valid,true);assert.equal((await f.treasury.snapshot(owner)).wallet1Paise,'0');
  }finally{await f.db.close();}
});
test('source learning rejects fabricated quotations, identity/context changes and promotion of rejected lessons',async()=>{
  const f=await setup();try{
    const t=await f.service.request(researcher,key(),f.input),body={requestId:t.id,contextHash:t.contextHash,proposal:f.proposal};
    await assert.rejects(()=>f.service.submit({...researcher,id:'other'},key(),body),/assigned/);
    await assert.rejects(()=>f.service.submit(researcher,key(),{...body,contextHash:'a'.repeat(64)}),/context/);
    await assert.rejects(()=>f.service.submit(researcher,key(),{...body,proposal:{...f.proposal,quote:'Invented publisher quotation'}}),/Quote/);
    assert.throws(()=>f.service.submit(researcher,key(),{...body,proposal:{...f.proposal,verified:true}}));
    const p=await f.service.submit(researcher,key(),body);
    await f.service.review(evaluator,key(),{requestId:t.id,decision:'rejected',reason:'Not a useful lesson'});
    await assert.rejects(()=>f.org.verifyLesson(evaluator,key(),{lessonId:p.lessonId}),/dedicated/);
    await assert.rejects(()=>f.service.review(evaluator,key(),{requestId:t.id,decision:'accepted',reason:'Changed mind'}),/fixed/);
    await assert.rejects(()=>f.service.submit(researcher,key(),{...body,proposal:{...f.proposal,lesson:'Changed'}}),/fixed/);
  }finally{await f.db.close();}
});
test('source withdrawal blocks acceptance, retains rejection and respects shared model quota and halt',async()=>{
  const f=await setup();try{
    await f.dev.configure(owner,key(),{expectedRevision:1,enabled:true,model:{name:'fixture',baseUrl:'http://127.0.0.1:8000/v1'},maxPerDay:1,maxLifetime:1});
    const t=await f.service.request(researcher,key(),f.input);
    await assert.rejects(()=>f.service.request(researcher,key(),f.input),/capacity/);
    await f.service.submit(researcher,key(),{requestId:t.id,contextHash:t.contextHash,proposal:f.proposal});
    await f.org.revoke(owner,key(),{kind:'source',targetId:'publisher',reason:'Withdrawn source'});
    await assert.rejects(()=>f.service.review(evaluator,key(),{requestId:t.id,decision:'accepted',reason:'Accept'}),/verified/);
    await f.db.transaction(tx=>tx.query('UPDATE system_lock SET halted=true WHERE id=1'));
    await f.service.review(evaluator,key(),{requestId:t.id,decision:'rejected',reason:'No current support'});
    await assert.rejects(()=>f.service.request(researcher,key(),f.input),/halted/);
  }finally{await f.db.close();}
});
test('policy changes, retired recipients and legacy evidence cannot authorise source inference',async()=>{
  const f=await setup();try{
    const legacy=await f.evidence();await assert.rejects(()=>f.service.request(researcher,key(),{...f.input,evidenceId:legacy.evidenceId}),/observation/);
    const t=await f.service.request(researcher,key(),f.input);
    await assert.rejects(()=>f.dev.preflight(researcher,{requestId:t.id}),/Portfolio/);
    await f.db.transaction(tx=>tx.query("UPDATE bots SET state='retired' WHERE id='mentor'"));
    await assert.rejects(()=>f.service.preflight(researcher,{requestId:t.id}),/Active bot/);
    await f.dev.configure(owner,key(),{expectedRevision:1,enabled:false,model:null,maxPerDay:4,maxLifetime:4});
    await assert.rejects(()=>f.service.preflight(researcher,{requestId:t.id}),/policy/);
  }finally{await f.db.close();}
});
test('source learning HTTP endpoints enforce role separation',async()=>{
  const f=await setup();let app;try{
    app=await createApp(f.cfg,f.db,true);await app.listen(0,'127.0.0.1');const base=await app.getUrl();
    const post=(role:string,path:string,body:unknown)=>fetch(base+'/v1/learning/sources/'+path,{method:'POST',headers:{Authorization:'Bearer '+f.cfg.principals.find(p=>p.role===role)!.token,'Content-Type':'application/json','Idempotency-Key':key()},body:JSON.stringify(body)});
    assert.equal((await post('evaluator','requests',f.input)).status,403);
    const response=await post('researcher','requests',f.input);assert.equal(response.status,201);const t=await response.json();
    assert.equal((await post('researcher','proposals',{requestId:t.id,contextHash:t.contextHash,proposal:f.proposal})).status,201);
    assert.equal((await post('researcher','reviews',{requestId:t.id,decision:'accepted',reason:'Self'})).status,403);
    assert.equal((await post('evaluator','reviews',{requestId:t.id,decision:'accepted',reason:'Supported interpretation'})).status,201);
  }finally{if(app)await app.close();await f.db.close();}
});
