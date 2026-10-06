import test from 'node:test';
import assert from 'node:assert/strict';
import { BotKnowledge } from '../src/bot-knowledge.js';
import { ResearchDevelopment } from '../src/development.js';
import { createApp } from '../src/app.js';
import { fixture,owner,researcher,evaluator,key } from './helpers.js';

const model={name:'Qwen/Qwen3.5-9B',baseUrl:'http://127.0.0.1:8000/v1'};
const completed={outcome:'completed',engine:'hermes-f97608f178d1',promptVersion:'aa71e3a6bda06caf',latencyMs:1800,promptTokens:900,completionTokens:120};
async function setup(maxTokensPerDay?:number|null){
  const f=await fixture(),k=new BotKnowledge(f.db),dev=new ResearchDevelopment(f.db);
  for(const bot of ['mentor','student'])await f.org.bot(owner,key(),{id:bot,name:bot,department:'research',specialty:bot,method:'reasoning',contribution:'Different research role',budgetPaise:'0'});
  const evidence=await f.evidence();
  const lesson=await f.org.lesson(researcher,key(),{botId:'mentor',content:'Deduct fees and slippage before comparing returns.',evidenceId:evidence.evidenceId});
  await f.org.verifyLesson(evaluator,key(),{lessonId:lesson.id});
  await dev.configure(owner,key(),{expectedRevision:0,enabled:true,model,maxPerDay:10,maxLifetime:100,...(maxTokensPerDay!==undefined?{maxTokensPerDay}:{})});
  const request=()=>k.request(researcher,key(),{botId:'student',lessonIds:[lesson.id],task:'Design a fresh cost-aware comparison'});
  const reservation=async(id:string)=>(await f.db.transaction(tx=>tx.query('SELECT inference_reservation(context) AS n FROM development_requests WHERE id=$1',[id]))).rows[0]!.n as number;
  return {...f,k,dev,request,reservation,usage:dev.inference()};
}

test('the request author records one immutable inference outcome; failures notify the owner',async()=>{
  const f=await setup();try{
    const ticket=await f.request(),body={requestId:ticket.id,...completed},command=key();
    const first=await f.usage.report(researcher,command,body);
    assert.deepEqual(first,{requestId:ticket.id,kind:'knowledge-transfer-v1',outcome:'completed',recorded:true,attested:false});
    assert.deepEqual(await f.usage.report(researcher,command,body),first);
    assert.deepEqual(await f.usage.report(researcher,key(),body),first);
    await assert.rejects(async()=>f.usage.report(researcher,key(),{...body,completionTokens:121}),/different inference outcome/);
    await assert.rejects(async()=>f.usage.report({...researcher,id:'other-researcher'},key(),body),/assigned researcher/);
    await assert.rejects(async()=>f.usage.report(evaluator,key(),body),/not permitted/);
    await assert.rejects(async()=>f.usage.report(researcher,key(),{...body,requestId:'7f1e7b38-58d6-4d3c-9f0c-1d6b0a1e2f3a'}),/not found/);
    for(const bad of [{...body,failureCode:'X_FAILED'},{...body,outcome:'failed'},{...body,promptVersion:'not-a-hash'},
      {...body,engine:'Hermes Engine'},{...body,promptTokens:-1},{...body,extra:true}])
      await assert.rejects(async()=>f.usage.report(researcher,key(),bad),/Invalid request/);
    const notices=async()=>(await f.db.transaction(tx=>tx.query("SELECT count(*)::int AS n FROM audit_events WHERE action LIKE 'inference.%'"))).rows[0]!.n;
    assert.equal(await notices(),0);
    // Reports remain possible during a halt: they are history, not permission to infer.
    await f.db.transaction(tx=>tx.query('UPDATE system_lock SET halted=true WHERE id=1'));
    const failed=await f.request().catch(()=>null);assert.equal(failed,null);
    await f.db.transaction(tx=>tx.query('UPDATE system_lock SET halted=false WHERE id=1'));
    const second=await f.request();
    await f.db.transaction(tx=>tx.query('UPDATE system_lock SET halted=true WHERE id=1'));
    const uncertain=await f.usage.report(researcher,key(),{requestId:second.id,outcome:'uncertain',failureCode:'INFERENCE_INTERRUPTED',
      engine:'hermes-f97608f178d1',promptVersion:'aa71e3a6bda06caf'});
    assert.equal(uncertain.outcome,'uncertain');assert.equal(await notices(),1);
    await assert.rejects(async()=>f.db.transaction(tx=>tx.query("UPDATE inference_reports SET latency_ms=1")));
    assert.equal((await f.ops.verifyAudit(owner)).valid,true);
  }finally{await f.db.close();}
});

test('the owner token ceiling charges reservations until usage is reported, across request kinds',async()=>{
  const f=await setup(1_000_000);try{
    const first=await f.request(),reserve=await f.reservation(first.id);
    assert.ok(reserve>1536,'reservation includes the maximum completion and context');
    // Tighten the ceiling to one and a half reservations; omitted fields keep the ceiling on later revisions.
    await f.dev.configure(owner,key(),{expectedRevision:1,enabled:true,model,maxPerDay:10,maxLifetime:100,maxTokensPerDay:Math.floor(reserve*1.5)});
    await assert.rejects(async()=>f.request(),/token ceiling/);
    await f.usage.report(researcher,key(),{requestId:first.id,...completed,promptTokens:200,completionTokens:50});
    const second=await f.request();
    let status=await f.usage.status(owner);
    assert.equal(status.policy.maxTokensPerDay,Math.floor(reserve*1.5));
    assert.equal(status.last24Hours.requests,2);assert.equal(status.last24Hours.reported,1);
    assert.equal(status.last24Hours.charged_tokens,250+await f.reservation(second.id));
    assert.equal(status.last24Hours.estimated_requests,1);
    assert.equal(status.last24Hours.remaining_tokens,Math.floor(reserve*1.5)-status.last24Hours.charged_tokens);
    const kind=status.byKind.find(k=>k.key==="knowledge-transfer-v1")!;
    assert.equal(kind.requests,2);assert.equal(kind.completed,1);assert.equal(kind.prompt_tokens,200);assert.equal(kind.latency_p50_ms,1800);
    assert.equal(status.byModel[0]!.key,'Qwen/Qwen3.5-9B');assert.equal(status.recent.length,1);
    await f.dev.configure(owner,key(),{expectedRevision:2,enabled:true,model,maxPerDay:10,maxLifetime:100});
    assert.equal((await f.usage.status(owner)).policy.maxTokensPerDay,Math.floor(reserve*1.5));
    await assert.rejects(async()=>f.request(),/token ceiling/);
    await f.dev.configure(owner,key(),{expectedRevision:3,enabled:true,model,maxPerDay:10,maxLifetime:100,maxTokensPerDay:null});
    await f.request();
    status=await f.usage.status(evaluator);assert.equal(status.policy.maxTokensPerDay,null);assert.equal(status.last24Hours.remaining_tokens,null);
    await assert.rejects(async()=>f.usage.status(researcher),/not permitted/);
    await assert.rejects(async()=>f.dev.configure(owner,key(),{expectedRevision:4,enabled:true,model,maxPerDay:10,maxLifetime:100,maxTokensPerDay:999}),/Invalid request/);
  }finally{await f.db.close();}
});

test('inference HTTP routes enforce roles and idempotency',async()=>{
  const f=await setup();let app;try{
    const ticket=await f.request();
    app=await createApp(f.cfg,f.db,true);await app.listen(0,'127.0.0.1');const base=await app.getUrl();
    const token=(role:string)=>f.cfg.principals.find(p=>p.role===role)!.token;
    const call=(role:string,method:string,path:string,body?:unknown,idempotency=true)=>fetch(base+'/v1/development/'+path,{method,
      headers:{Authorization:'Bearer '+token(role),'Content-Type':'application/json',...(idempotency?{'Idempotency-Key':key()}:{})},
      body:body===undefined?undefined:JSON.stringify(body)});
    const body={requestId:ticket.id,...completed};
    assert.equal((await call('evaluator','POST','inference-reports',body)).status,403);
    assert.equal((await call('researcher','POST','inference-reports',body,false)).status,400);
    assert.equal((await call('researcher','POST','inference-reports',body)).status,201);
    assert.equal((await call('researcher','GET','inference-usage')).status,403);
    const usage=await call('owner','GET','inference-usage');assert.equal(usage.status,200);
    assert.equal((await usage.json()).last24Hours.reported,1);
  }finally{if(app)await app.close();await f.db.close();}
});

test('the owner selects the inference engine; tickets carry it and the default stays Hermes',async()=>{
  const f=await setup();try{
    const hermes=await f.request();
    assert.equal(hermes.model.engine,'hermes-rd-v1');assert.equal(hermes.model.sourceRevision,'f97608f178d1ffeca59860195ab7da295f7c8e5f');
    await f.dev.configure(owner,key(),{expectedRevision:1,enabled:true,model:{...model,engine:'direct-structured-v1'},maxPerDay:10,maxLifetime:100});
    const direct=await f.request();
    assert.deepEqual({engine:direct.model.engine,sourceRevision:direct.model.sourceRevision,decoding:direct.model.decoding,tools:direct.model.tools},
      {engine:'direct-structured-v1',sourceRevision:null,decoding:'json-schema',tools:[]});
    await assert.rejects(async()=>f.dev.configure(owner,key(),{expectedRevision:2,enabled:true,model:{...model,engine:'tool-agent'},maxPerDay:10,maxLifetime:100}),/Invalid request/);
    // A model profile cannot smuggle extra runtime fields such as tools.
    await assert.rejects(async()=>f.dev.configure(owner,key(),{expectedRevision:2,enabled:true,model:{...model,tools:['shell']},maxPerDay:10,maxLifetime:100}),/Invalid request/);
  }finally{await f.db.close();}
});
