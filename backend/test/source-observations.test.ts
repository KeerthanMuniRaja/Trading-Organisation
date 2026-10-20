import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,owner,researcher,evaluator,market,trader,key } from './helpers.js';
import { BotKnowledge } from '../src/bot-knowledge.js';
import { ResearchDevelopment } from '../src/development.js';
import { createApp } from '../src/app.js';

async function setup(){
  const f=await fixture();
  await f.org.sources(owner,key(),{id:'publisher',name:'Fixture publisher',url:'https://example.org/feed',approved:true});
  const input={sourceId:'publisher',url:'https://example.org/news/one',title:'Fixture news',kind:'news',content:'Costs affect net results.',publishedAt:'2025-01-01T00:00:00Z'};
  return {...f,input,observations:f.org.observations()};
}
test('source snapshots deduplicate retries, preserve revisions and remain unverified until independent review',async()=>{
  const f=await setup();try{
    const command=key(),first=await f.observations.ingest(researcher,command,f.input);
    const replay=await f.observations.ingest(researcher,command,f.input);assert.equal(replay.id,first.id);
    const duplicate=await f.observations.ingest(market,key(),f.input);assert.equal(duplicate.id,first.id);assert.equal(duplicate.duplicate,true);
    await assert.rejects(()=>f.org.reviewEvidence({...evaluator,id:researcher.id},key(),{evidenceId:first.id,status:'verified'}),/own evidence/);
    await f.org.reviewEvidence(evaluator,key(),{evidenceId:first.id,status:'verified'});
    const revision=await f.observations.ingest(researcher,key(),{...f.input,content:'Correction: include slippage too.'});assert.notEqual(revision.id,first.id);
    const rows=await f.observations.list(owner,{sourceId:'publisher'});assert.equal(rows.observations.length,2);
    assert.equal(rows.observations.find(r=>r.evidence_id===first.id)!.usable,true);
    assert.equal(rows.observations.find(r=>r.evidence_id===revision.id)!.usable,false);
    assert.ok(new Date(rows.observations[0]!.observed_at).getTime()>new Date(f.input.publishedAt).getTime());
    await assert.rejects(()=>f.db.transaction(tx=>tx.query('DELETE FROM source_observations')));
    assert.equal((await f.ops.verifyAudit(owner)).valid,true);assert.equal((await f.treasury.snapshot(owner)).wallet1Paise,'0');
  }finally{await f.db.close();}
});
test('source boundary rejects forged origin, future time, extra authority, halt and withdrawn source',async()=>{
  const f=await setup();try{
    assert.throws(()=>f.observations.ingest(trader,key(),f.input));
    for(const url of ['https://example.org.evil.test/a','https://evil.test/a','https://example.org:444/a'])await assert.rejects(()=>f.observations.ingest(researcher,key(),{...f.input,url}),/origin/);
    for(const url of ['http://example.org/a','https://user:secret@example.org/a','https://example.org/a#fragment'])assert.throws(()=>f.observations.ingest(researcher,key(),{...f.input,url}));
    assert.throws(()=>f.observations.ingest(researcher,key(),{...f.input,status:'verified'}));
    assert.throws(()=>f.observations.ingest(researcher,key(),{...f.input,observedAt:f.input.publishedAt}));
    await assert.rejects(()=>f.observations.ingest(researcher,key(),{...f.input,publishedAt:'2099-01-01T00:00:00Z'}),/future/);
    await f.db.transaction(tx=>tx.query('UPDATE system_lock SET halted=true WHERE id=1'));
    await assert.rejects(()=>f.observations.ingest(researcher,key(),f.input),/halted/);
    await f.db.transaction(tx=>tx.query('UPDATE system_lock SET halted=false WHERE id=1'));
    await f.org.revoke(owner,key(),{kind:'source',targetId:'publisher',reason:'Withdrawn'});
    await assert.rejects(()=>f.observations.ingest(researcher,key(),f.input),/Approved/);
  }finally{await f.db.close();}
});
test('reviewed external evidence connects to bot context and graph; revocation removes usability',async()=>{
  const f=await setup();try{
    for(const bot of ['mentor','student'])await f.org.bot(owner,key(),{id:bot,name:bot,department:'research',specialty:bot,method:'reasoning',contribution:'Role '+bot,budgetPaise:'0'});
    const e=await f.observations.ingest(researcher,key(),f.input);
    const lessonInput={botId:'mentor',content:'Account for transaction costs.',evidenceId:e.id};
    await assert.rejects(()=>f.org.lesson(researcher,key(),lessonInput),/Verified/);
    await f.org.reviewEvidence(evaluator,key(),{evidenceId:e.id,status:'verified'});
    const lesson=await f.org.lesson(researcher,key(),lessonInput);await f.org.verifyLesson(evaluator,key(),{lessonId:lesson.id});
    await new ResearchDevelopment(f.db).configure(owner,key(),{expectedRevision:0,enabled:true,model:{name:'fixture',baseUrl:'http://127.0.0.1:8000/v1'},maxPerDay:2,maxLifetime:2});
    const k=new BotKnowledge(f.db),request=await k.request(researcher,key(),{botId:'student',task:'Apply cost reasoning',lessonIds:[lesson.id]});
    assert.equal(request.context.lessons[0]!.provenance.articleUrl,f.input.url);
    const graph=await k.graph(owner,{botId:'student'});assert.ok(graph.edges.some(e=>e.type==='observed-as'));
    const ids=new Set(graph.nodes.map(n=>n.id));assert.ok(graph.edges.every(e=>ids.has(e.from)&&ids.has(e.to)));
    await f.org.revoke(owner,key(),{kind:'source',targetId:'publisher',reason:'Correction'});
    assert.equal((await f.observations.list(owner,{sourceId:'publisher'})).observations[0]!.usable,false);
    await assert.rejects(()=>k.preflight(researcher,{requestId:request.id}),/verified/);
  }finally{await f.db.close();}
});
test('observation HTTP endpoints enforce roles and strict request contracts',async()=>{
  const f=await setup();let app;try{
    app=await createApp(f.cfg,f.db,true);await app.listen(0,'127.0.0.1');const base=await app.getUrl();
    const post=(role:string,path:string,body:unknown)=>fetch(base+'/v1/sources/observations'+path,{method:'POST',headers:{Authorization:'Bearer '+f.cfg.principals.find(p=>p.role===role)!.token,'Content-Type':'application/json','Idempotency-Key':key()},body:JSON.stringify(body)});
    assert.equal((await post('trader','',f.input)).status,403);
    assert.equal((await post('researcher','',{...f.input,status:'verified'})).status,400);
    assert.equal((await post('researcher','',f.input)).status,201);
    const response=await post('evaluator','/query',{sourceId:'publisher',status:'unverified'});assert.equal(response.status,201);
    assert.equal((await response.json()).observations.length,1);
    assert.equal((await post('researcher','/review-queue',{})).status,403);
    assert.equal((await post('evaluator','/review-queue',{status:'verified'})).status,400);
    const queue=await post('evaluator','/review-queue',{});assert.equal(queue.status,201);
    assert.equal((await queue.json()).observations.length,1);
  }finally{if(app)await app.close();await f.db.close();}
});

test('review queue pages oldest first and retains a reviewed cursor without skipping pending evidence',async()=>{
  const f=await setup();try{
    const ids=[];
    for(let i=0;i<4;i++)ids.push((await f.observations.ingest(researcher,key(),{...f.input,content:'Observation '+i})).id);
    const first=await f.observations.reviewQueue(evaluator,{limit:2});
    assert.deepEqual(first.observations.map(r=>r.evidence_id),ids.slice(0,2));
    assert.equal(first.nextCursor,ids[1]);
    await f.org.reviewEvidence(evaluator,key(),{evidenceId:ids[1],status:'verified'});
    const second=await f.observations.reviewQueue(evaluator,{limit:2,after:first.nextCursor});
    assert.deepEqual(second.observations.map(r=>r.evidence_id),ids.slice(2));
    assert.equal(second.nextCursor,null);
    assert.equal(first.observations[0]!.ready_for_review,true);
    assert.deepEqual(first.observations[0]!.blockers,[]);
    await assert.rejects(()=>f.observations.reviewQueue(evaluator,{after:'00000000-0000-4000-8000-000000000000'}),/cursor/);
    assert.throws(()=>f.observations.reviewQueue(researcher,{}));
    assert.throws(()=>f.observations.reviewQueue(evaluator,{limit:51}));
  }finally{await f.db.close();}
});

test('review queue exposes blocked provenance without allowing authors to review themselves',async()=>{
  const f=await setup();try{
    const one=await f.observations.ingest(researcher,key(),f.input);
    const sameIdentity={...evaluator,id:researcher.id};
    assert.equal((await f.observations.reviewQueue(sameIdentity,{})).observations.length,0);
    const self=(await f.observations.reviewQueue(sameIdentity,{includeBlocked:true})).observations[0]!;
    assert.deepEqual(self.blockers,['self-review']);assert.equal(self.ready_for_review,false);
    await f.org.revoke(owner,key(),{kind:'source',targetId:'publisher',reason:'Withdraw this source'});
    assert.equal((await f.observations.reviewQueue(evaluator,{})).observations.length,0);
    const blocked=(await f.observations.reviewQueue(evaluator,{includeBlocked:true,sourceId:'publisher'})).observations[0]!;
    assert.equal(blocked.evidence_id,one.id);assert.deepEqual(blocked.blockers,['source-withdrawn']);
    assert.equal(blocked.status,'unverified');assert.equal(blocked.provenance,'collector-submitted');
    assert.equal((await f.observations.reviewQueue(owner,{includeBlocked:true,sourceId:'unknown'})).observations.length,0);
  }finally{await f.db.close();}
});
