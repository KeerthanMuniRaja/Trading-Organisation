import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,owner,researcher,evaluator,key} from './helpers.js';

test('exact evidence status exposes current eligibility without a recent-history cutoff',async()=>{
  const f=await fixture();try{
    const e=await f.evidence();
    const input={evidenceIds:[e.evidenceId,crypto.randomUUID()]};
    let result=await f.org.evidenceStatus(researcher,input);
    assert.equal(result.evidence.length,1);assert.equal(result.evidence[0]!.usable,true);
    assert.throws(()=>f.org.evidenceStatus({id:'trader',role:'trader'},input),/not permitted/);
    assert.throws(()=>f.org.evidenceStatus(owner,{evidenceIds:[e.evidenceId,e.evidenceId]}),/Invalid request/);
    assert.throws(()=>f.org.evidenceStatus(owner,{evidenceIds:Array.from({length:51},()=>crypto.randomUUID())}),/Invalid request/);
    await f.org.revoke(owner,key(),{kind:'source',targetId:e.sourceId,reason:'Withdraw support'});
    result=await f.org.evidenceStatus(evaluator,input);
    assert.equal(result.evidence[0]!.status,'verified');assert.equal(result.evidence[0]!.usable,false);
    assert.equal(result.evidence[0]!.source_approved,false);
  }finally{await f.db.close();}
});

test('evidence review binds snapshot provenance and rechecks source approval',async()=>{
  const f=await fixture();try{
    const sourceId='binding-source';
    await f.org.sources(owner,key(),{id:sourceId,name:'Source',url:'https://example.org',approved:true});
    const expected={sourceId,content:'Reviewed news snapshot',kind:'news' as const,publishedAt:'2025-01-01T00:00:00Z',
      observation:{url:'https://example.org/article',title:'Reviewed title'}};
    const {observation,...snapshot}=expected;
    const e=await f.org.observations().ingest(researcher,key(),{...snapshot,...observation});
    for(const mismatch of [{content:'Changed'},{sourceId:'other'},{kind:'filing'},
      {publishedAt:'2025-01-02T00:00:00Z'},{observation:{...expected.observation,title:'Changed'}},
      {observation:{...expected.observation,url:'https://example.org/other'}},{observation:undefined}]){
      await assert.rejects(f.org.reviewEvidence(evaluator,key(),{evidenceId:e.id,status:'verified',expected:{...expected,...mismatch}}),/does not match/);
    }
    const command=key();
    await f.org.reviewEvidence(evaluator,command,{evidenceId:e.id,status:'verified',expected});
    await f.org.reviewEvidence(evaluator,command,{evidenceId:e.id,status:'verified',expected});
    const other=await f.org.evidence(researcher,key(),{sourceId,content:'Another record',kind:'dataset',publishedAt:expected.publishedAt});
    await assert.rejects(f.org.reviewEvidence(evaluator,key(),{evidenceId:other.id,status:'verified',expected:{...expected,content:'Another record',kind:'dataset'}}),/observation does not match/);
    const future=await f.org.evidence(researcher,key(),{sourceId,content:'Not yet published',kind:'news',publishedAt:new Date(Date.now()+25000).toISOString()});
    await assert.rejects(f.org.reviewEvidence(evaluator,key(),{evidenceId:future.id,status:'verified'}),/Future evidence/);
    await f.org.revoke(owner,key(),{kind:'source',targetId:sourceId,reason:'Withdrawn during review'});
    await assert.rejects(f.org.reviewEvidence(evaluator,key(),{evidenceId:other.id,status:'verified'}),/Approved source/);
    await f.org.reviewEvidence(evaluator,key(),{evidenceId:other.id,status:'rejected'});
    assert.equal((await f.ops.verifyAudit(owner)).valid,true);
  }finally{await f.db.close();}
});

test('automatic lesson review checks the stored content, evidence and bot before publication',async()=>{
  const f=await fixture();try{
    const {evidenceId}=await f.evidence();
    await f.org.bot(owner,key(),{id:'reader',name:'Reader',department:'research',specialty:'news',method:'review',contribution:'Learn attributed claims',budgetPaise:'0'});
    const expected={botId:'reader',evidenceId,content:'Attributed and checked claim'};
    const lesson=await f.org.lesson(researcher,key(),expected);
    const other=await f.evidence();
    for(const mismatch of [{content:'Different claim'},{botId:'another-bot'},{evidenceId:other.evidenceId}]){
      await assert.rejects(f.org.verifyLesson(evaluator,key(),{lessonId:lesson.id,expected:{...expected,...mismatch}}),/does not match/);
      assert.equal((await f.org.knowledge(researcher)).lessons.length,0);
    }
    await f.org.verifyLesson(evaluator,key(),{lessonId:lesson.id,expected});
    assert.equal((await f.org.knowledge(researcher)).lessons[0]!.id,lesson.id);
    assert.equal((await f.ops.verifyAudit(owner)).valid,true);
  }finally{await f.db.close();}
});
