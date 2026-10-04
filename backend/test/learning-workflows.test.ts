import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,owner,researcher,evaluator,key } from './helpers.js';
import { LearningWorkflows } from '../src/learning-workflows.js';
import { SourceLearning } from '../src/source-learning.js';
import { BotKnowledge } from '../src/bot-knowledge.js';
import { KnowledgeAssessments } from '../src/knowledge-assessments.js';
import { ResearchDevelopment } from '../src/development.js';
import { Challenge } from '../src/skill-contract.js';
import { createApp } from '../src/app.js';
async function setup(){
  const f=await fixture(),w=new LearningWorkflows(f.db),s=new SourceLearning(f.db),k=new BotKnowledge(f.db),a=new KnowledgeAssessments(f.db);
  for(const bot of ['mentor','student'])await f.org.bot(owner,key(),{id:bot,name:bot,department:'research',specialty:bot,method:'reasoning',contribution:'Role '+bot,budgetPaise:'0'});
  await f.org.sources(owner,key(),{id:'publisher',name:'Fixture',url:'https://example.org',approved:true});
  const e=await f.org.observations().ingest(researcher,key(),{sourceId:'publisher',url:'https://example.org/story',title:'Cost principle',kind:'article',content:'Fees and slippage reduce net returns.',publishedAt:'2025-01-01T00:00:00Z'});
  await f.org.reviewEvidence(evaluator,key(),{evidenceId:e.id,status:'verified'});
  await new ResearchDevelopment(f.db).configure(owner,key(),{expectedRevision:0,enabled:true,model:{name:'fixture',baseUrl:'http://127.0.0.1:8000/v1'},maxPerDay:5,maxLifetime:5});
  const input={mentorId:'mentor',recipientId:'student',evidenceId:e.id,researcherId:researcher.id,evaluatorId:evaluator.id,task:'Apply transaction costs to a new scenario'};
  return {...f,w,s,k,a,input};
}
async function sourceStage(f:Awaited<ReturnType<typeof setup>>,workflowId:string){
  const p=await f.w.progress(researcher,{workflowId});assert.equal(p.state,'source');
  const t=await f.s.request(researcher,p.action!.requestKey,p.action!.body);
  await f.s.submit(researcher,key(),{requestId:t.id,contextHash:t.contextHash,proposal:{lesson:'Deduct costs before comparing outcomes.',quote:'Fees and slippage reduce net returns.',limitation:'Not proof of trading profitability.'}});
  await f.w.attach(researcher,key(),{workflowId,step:'source',referenceId:t.id});return t;
}
test('owner-defined workflow advances through independent reviews and fresh grading without new authority',async()=>{
  const f=await setup();try{
    const {workflowId}=await f.w.register(owner,key(),f.input),ref={workflowId};
    const t=await sourceStage(f,workflowId);assert.equal((await f.w.progress(researcher,ref)).state,'awaiting-source-review');
    await f.s.review(evaluator,key(),{requestId:t.id,decision:'accepted',reason:'Bounded source lesson'});
    let p=await f.w.progress(researcher,ref);assert.equal(p.state,'transfer');
    const kt=await f.k.request(researcher,p.action!.requestKey,p.action!.body);
    await f.k.submit(researcher,key(),{requestId:kt.id,contextHash:kt.contextHash,proposal:{summary:'Apply cost lesson',application:'Subtract stated costs',lessonIds:p.action!.body.lessonIds,checks:['Verify net results'],risks:['Source may not generalise']}});
    await f.w.attach(researcher,key(),{workflowId,step:'transfer',referenceId:kt.id});assert.equal((await f.w.progress(evaluator,ref)).state,'awaiting-transfer-review');
    await f.k.review(evaluator,key(),{requestId:kt.id,decision:'accepted',reason:'Test the cited plan'});
    assert.equal((await f.w.progress(researcher,ref)).action,null);p=await f.w.progress(evaluator,ref);assert.equal(p.state,'assessment-create');
    const assessment=await f.a.create(evaluator,p.action!.requestKey,p.action!.body);
    await f.w.attach(evaluator,key(),{workflowId,step:'assessment',referenceId:assessment.assessmentId});
    p=await f.w.progress(researcher,ref);assert.equal(p.state,'assessment-answer');const work=await f.a.work(researcher,p.action!.body);
    const answers=work.cases.map((c:{id:string;challenge:Challenge})=>{const x=c.challenge;let peak=0,dd=0;for(const n of x.equityPaise){peak=Math.max(peak,n);dd=Math.max(dd,(peak-n)/peak*10000);}return {caseId:c.id,answers:{netProfitPaise:x.grossProfitPaise-x.feesPaise-x.slippagePaise,maxDrawdownBps:dd,eligibleRecordIds:x.records.filter(r=>r.eventAt<=x.cutoff&&r.availableAt<=x.cutoff).map(r=>r.id),action:!x.control.halted&&x.control.evidenceVerified&&x.control.budget>=x.control.required?'research':'wait'}};});
    await f.a.submit(researcher,key(),{assessmentId:assessment.assessmentId,answers});p=await f.w.progress(evaluator,ref);assert.equal(p.state,'assessment-grade');
    await f.a.grade(evaluator,p.action!.requestKey,p.action!.body);
    const final=await f.w.progress(owner,ref);assert.equal(final.state,'completed');assert.equal(final.assessment.fitnessChanged,false);assert.equal(final.assessment.passedChecks,16);
    assert.equal((await f.w.progress(researcher,ref)).action,null);
    for(const table of ['learning_workflows','learning_workflow_links'])await assert.rejects(()=>f.db.transaction(tx=>tx.query('DELETE FROM '+table)));
    assert.equal((await f.ops.verifyAudit(owner)).valid,true);assert.equal((await f.treasury.snapshot(owner)).wallet1Paise,'0');
  }finally{await f.db.close();}
});
test('workflow identity and stage linkage reject substitution and preserve fixed links',async()=>{
  const f=await setup();try{
    const {workflowId}=await f.w.register(owner,key(),f.input),ref={workflowId};
    assert.throws(()=>f.w.register(researcher,key(),f.input));
    await assert.rejects(()=>f.w.progress({...researcher,id:'intruder'},ref),/identity/);
    await assert.rejects(()=>f.w.attach(evaluator,key(),{workflowId,step:'source',referenceId:crypto.randomUUID()}),/role/);
    const t=await sourceStage(f,workflowId);await f.w.attach(researcher,key(),{workflowId,step:'source',referenceId:t.id});
    await assert.rejects(()=>f.w.attach(researcher,key(),{workflowId,step:'source',referenceId:crypto.randomUUID()}),/fixed/);
    const other=await f.w.register(owner,key(),{...f.input,mentorId:'student',recipientId:'mentor'});
    await assert.rejects(()=>f.w.attach(researcher,key(),{workflowId:other.workflowId,step:'source',referenceId:t.id}),/another workflow/);
    const unlinked=await f.s.request(researcher,key(),{botId:'mentor',evidenceId:f.input.evidenceId});
    await f.s.submit(researcher,key(),{requestId:unlinked.id,contextHash:unlinked.contextHash,proposal:{lesson:'Account for costs.',quote:'Fees and slippage reduce net returns.',limitation:'A research principle only.'}});
    await assert.rejects(()=>f.w.attach(researcher,key(),{workflowId:other.workflowId,step:'source',referenceId:unlinked.id}),/match/);
    await assert.rejects(()=>f.w.attach(researcher,key(),{workflowId,step:'transfer',referenceId:crypto.randomUUID()}),/Accepted/);
  }finally{await f.db.close();}
});
test('workflow waits honestly on rejection, halt, support withdrawal, policy change and cancellation',async()=>{
  const f=await setup();try{
    const {workflowId}=await f.w.register(owner,key(),f.input),ref={workflowId},t=await sourceStage(f,workflowId);
    await f.s.review(evaluator,key(),{requestId:t.id,decision:'rejected',reason:'Weak interpretation'});assert.equal((await f.w.progress(researcher,ref)).state,'rejected');
    await f.db.transaction(tx=>tx.query('UPDATE system_lock SET halted=true WHERE id=1'));assert.equal((await f.w.progress(researcher,ref)).state,'halted');
    await f.db.transaction(tx=>tx.query('UPDATE system_lock SET halted=false WHERE id=1'));
    await f.org.revoke(owner,key(),{kind:'source',targetId:'publisher',reason:'Withdrawn'});assert.equal((await f.w.progress(researcher,ref)).state,'support-withdrawn');
    await new ResearchDevelopment(f.db).configure(owner,key(),{expectedRevision:1,enabled:false,model:null,maxPerDay:5,maxLifetime:5});assert.equal((await f.w.progress(researcher,ref)).state,'policy-changed');
    await f.w.cancel(owner,key(),{workflowId,reason:'Stop workflow'});assert.equal((await f.w.progress(evaluator,ref)).state,'cancelled');
    await assert.rejects(()=>f.w.attach(researcher,key(),{workflowId,step:'source',referenceId:t.id}),/cancelled/);
    await assert.rejects(()=>f.db.transaction(tx=>tx.query('DELETE FROM learning_workflow_cancellations')));
  }finally{await f.db.close();}
});
test('workflow HTTP routes restrict creation and return no action to the wrong role',async()=>{
  const f=await setup();let app;try{
    app=await createApp(f.cfg,f.db,true);await app.listen(0,'127.0.0.1');const base=await app.getUrl();
    const post=(role:string,path:string,body:unknown)=>fetch(base+'/v1/learning/workflows'+path,{method:'POST',headers:{Authorization:'Bearer '+f.cfg.principals.find(p=>p.role===role)!.token,'Content-Type':'application/json','Idempotency-Key':key()},body:JSON.stringify(body)});
    assert.equal((await post('researcher','',f.input)).status,403);const created=await post('owner','',f.input);assert.equal(created.status,201);const {workflowId}=await created.json();
    const p=await post('evaluator','/progress',{workflowId});assert.equal(p.status,201);assert.equal((await p.json()).action,null);
    assert.equal((await post('researcher','/cancellations',{workflowId,reason:'Stop'})).status,403);
  }finally{if(app)await app.close();await f.db.close();}
});
