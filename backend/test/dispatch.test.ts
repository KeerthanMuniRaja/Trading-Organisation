import test from 'node:test';
import assert from 'node:assert/strict';
import { ResearchDispatch } from '../src/dispatch.js';
import { ResearchLifecycle } from '../src/lifecycle.js';
import { PortfolioResearch } from '../src/portfolio.js';
import { OrganisationReport } from '../src/organisation-report.js';
import { OrganisationalLearning } from '../src/learning.js';
import { ResearchDevelopment } from '../src/development.js';
import { DevelopmentExperiments } from '../src/development-experiments.js';
import { fixture,owner,researcher,evaluator,key } from './helpers.js';

async function setup(method:'equal_weight'|'minimum_variance'='equal_weight'){
  const f=await fixture(),dispatch=new ResearchDispatch(f.db),life=new ResearchLifecycle(f.db),portfolio=new PortfolioResearch(f.db);
  try{
    const evidence=await f.evidence();
    await f.org.bot(owner,key(),{id:'teacher',name:'Teacher',department:'education',specialty:'research',method:'curriculum',contribution:'Research discipline',budgetPaise:'0'});
    const lesson=await f.org.lesson(researcher,key(),{botId:'teacher',content:'Fit using past training observations only',evidenceId:evidence.evidenceId});
    await f.org.verifyLesson(evaluator,key(),{lessonId:lesson.id});
    await life.blueprint(owner,key(),{id:'equal-student',name:'Allocation student',specialty:'allocation',method,contribution:'Measure a fixed diversified benchmark',evidenceId:evidence.evidenceId,lessonIds:[lesson.id]});
    const policy=(await life.status(owner)).policy!;
    await life.configure(owner,key(),{expectedRevision:0,rules:{...policy.rules,enabled:true}});
    await life.cycle(evaluator,key(),{});
    await f.db.transaction(tx=>tx.query("UPDATE lifecycle_policy SET last_cycle_at=now()-interval '2 hours'"));
    await life.cycle(evaluator,key(),{});
    const botId=(await life.community(owner))[0]!.id as string;
    const dataset=async(offset:number)=>{
      const rows=(count:number,start:number)=>Array.from({length:count},(_,i)=>({timestamp:new Date(Date.UTC(2020,0,1+start+i)).toISOString(),returns:[.001,.002,.003,.004]}));
      return portfolio.dataset(owner,key(),{evidenceId:evidence.evidenceId,purpose:'example-testing',assets:['A','B','C','D'],training:rows(60,0),holdout:rows(20,100+offset)});
    };
    const data=await dataset(0),other=await dataset(30),overlap=await dataset(10);
    const configure=async(extra:Record<string,unknown>={})=>{
      const current=(await dispatch.status(owner)).policy!;
      return dispatch.configure(owner,key(),{expectedRevision:current.revision,rules:{...current.rules,enabled:true,datasetIds:[data.id,other.id,overlap.id],...extra}});
    };
    const submission=(assignment:{id:string;leaseToken:string})=>({botId,datasetId:data.id,datasetDigest:data.digest,method,weights:[.25,.25,.25,.25],assignment});
    return {...f,createEvidence:f.evidence,dispatch,life,portfolio,botId,method,data,other,overlap,evidence,configure,submission};
  }catch(error){await f.db.close();throw error;}
}

test('dispatch defaults off, enforces owner policy and cannot be bypassed by managed students',async()=>{
  const f=await setup();try{
    assert.equal((await f.dispatch.cycle(evaluator,key(),{})).status,'disabled');
    assert.equal((await f.dispatch.claim(researcher,key(),{})).assignment,null);
    assert.throws(()=>f.dispatch.configure(researcher,key(),{}),/not permitted/);
    await assert.rejects(()=>f.portfolio.submit(researcher,key(),{botId:f.botId,datasetId:f.data.id,datasetDigest:f.data.digest,method:'equal_weight',weights:[.25,.25,.25,.25]}),/approved research assignment/);
    await f.configure({maxAssignmentsPerDay:1});
    const queued=await f.dispatch.cycle(evaluator,key(),{});assert.equal(queued.assignments.length,1);
    assert.equal((await f.dispatch.cycle(evaluator,key(),{})).assignments.length,0);
    const claimKey=key(),claim=await f.dispatch.claim(researcher,claimKey,{});
    assert.deepEqual(await f.dispatch.claim(researcher,claimKey,{}),claim);
    const assignment=claim.assignment!;
    const training=await f.portfolio.training(researcher,{datasetId:assignment.datasetId});
    assert.equal('holdout' in training,false);
    const submitted=await f.portfolio.submit(researcher,key(),f.submission({id:assignment.id,leaseToken:assignment.leaseToken}));
    const reviewQueue=await f.dispatch.reviews(evaluator);assert.equal(reviewQueue.trials[0]!.trialId,submitted.id);
    await f.portfolio.review(evaluator,key(),{trialId:submitted.id});
    assert.equal((await f.dispatch.cycle(evaluator,key(),{})).assignments.length,0);
    assert.equal((await f.treasury.snapshot(owner)).wallet1Paise,'0');
  }finally{await f.db.close();}
});

test('lease fencing, identity binding, atomic completion and overlap exclusion',async()=>{
  const f=await setup();try{
    await f.configure();await f.dispatch.cycle(evaluator,key(),{});
    const old=(await f.dispatch.claim(researcher,key(),{})).assignment!;
    await f.db.transaction(tx=>tx.query("UPDATE research_assignments SET lease_until=now()-interval '1 second' WHERE id=$1",[old.id]));
    const fresh=(await f.dispatch.claim(researcher,key(),{})).assignment!;
    assert.equal(fresh.id,old.id);assert.notEqual(fresh.leaseToken,old.leaseToken);
    await assert.rejects(()=>f.portfolio.submit(researcher,key(),f.submission({id:old.id,leaseToken:old.leaseToken})),/lease is no longer valid/);
    const body=f.submission({id:fresh.id,leaseToken:fresh.leaseToken});
    await assert.rejects(()=>f.portfolio.submit({id:'other-researcher',role:'researcher'},key(),body),/lease is no longer valid/);
    const command=key(),result=await f.portfolio.submit(researcher,command,body);
    assert.deepEqual(await f.portfolio.submit(researcher,command,body),result);
    assert.equal((await f.dispatch.cycle(evaluator,key(),{})).assignments.length,0);
    await f.portfolio.review(evaluator,key(),{trialId:result.id});
    await f.dispatch.cycle(evaluator,key(),{});
    const next=(await f.dispatch.claim(researcher,key(),{})).assignment!;
    assert.equal(next.datasetId,f.other.id);assert.notEqual(next.datasetId,f.overlap.id);
    assert.equal((await f.ops.verifyAudit(owner)).valid,true);
  }finally{await f.db.close();}
});

test('revocation and owner withdrawal fence active leases; retries stop after three attempts',async()=>{
  const f=await setup();try{
    await f.configure({maxLifetimeAssignments:1});await f.dispatch.cycle(evaluator,key(),{});
    for(let attempt=0;attempt<3;attempt++){
      const claim=(await f.dispatch.claim(researcher,key(),{})).assignment!;assert.ok(claim);
      await f.db.transaction(tx=>tx.query("UPDATE research_assignments SET lease_until=now()-interval '1 second' WHERE id=$1",[claim.id]));
    }
    assert.equal((await f.dispatch.claim(researcher,key(),{})).assignment,null);
    assert.equal((await f.dispatch.status(owner)).assignments[0]!.state,'failed');
    assert.equal((await f.dispatch.cycle(evaluator,key(),{})).assignments.length,0);
    await f.configure({maxLifetimeAssignments:3});await f.dispatch.cycle(evaluator,key(),{});
    const active=(await f.dispatch.claim(researcher,key(),{})).assignment!;
    await f.configure({datasetIds:[f.data.id]});
    assert.equal((await f.dispatch.status(owner)).assignments.find(a=>a.id===active.id)!.state,'cancelled');
    assert.equal((await f.life.community(owner))[0]!.reputation,0);
  }finally{await f.db.close();}
});

test('halt and disabled policy block claims and submissions; evidence revocation cancels queued work',async()=>{
  const f=await setup();try{
    await f.configure();await f.dispatch.cycle(evaluator,key(),{});
    const active=(await f.dispatch.claim(researcher,key(),{})).assignment!;
    const body=f.submission({id:active.id,leaseToken:active.leaseToken});
    await f.db.transaction(tx=>tx.query('UPDATE system_lock SET halted=true WHERE id=1'));
    assert.equal((await f.dispatch.claim(researcher,key(),{})).status,'halted');
    await assert.rejects(()=>f.portfolio.submit(researcher,key(),body),/System is halted/);
    await f.db.transaction(tx=>tx.query('UPDATE system_lock SET halted=false WHERE id=1'));
    await f.configure({enabled:false});
    await assert.rejects(()=>f.portfolio.submit(researcher,key(),body),/paused/);
    await f.org.revoke(owner,key(),{kind:'evidence',targetId:f.evidence.evidenceId,reason:'Fixture evidence withdrawn'});
    await f.dispatch.cycle(evaluator,key(),{});
    assert.equal((await f.dispatch.status(owner)).assignments[0]!.state,'cancelled');
  }finally{await f.db.close();}
});

test('owner report is read-only, restricted and explicit about disabled dispatch and unknown worker liveness',async()=>{
  const f=await setup();try{
    const report=new OrganisationReport(f.db);
    assert.throws(()=>report.snapshot(researcher),/not permitted/);
    assert.throws(()=>report.snapshot(evaluator),/not permitted/);
    const before=await f.ops.verifyAudit(owner);
    const first=await report.snapshot(owner),second=await report.snapshot(owner);
    assert.equal(first.summary.managedStudents,1);
    assert.equal(first.summary.readyForAssignment,0);
    assert.ok(first.blockers.some(r=>r.code==='DISPATCH_DISABLED'));
    assert.equal(first.workerLiveness,'not-observed');
    assert.equal(first.liveTradingEnabled,false);
    assert.equal(first.notifications.unreadCount,second.notifications.unreadCount);
    assert.deepEqual(await f.ops.verifyAudit(owner),before);
    assert.equal((await f.dispatch.status(owner)).assignments.length,0);
  }finally{await f.db.close();}
});

test('owner report follows allocation, evaluation, disjoint-window eligibility and consumed daily budget',async()=>{
  const f=await setup();try{
    const report=new OrganisationReport(f.db);
    await f.configure({maxAssignmentsPerDay:1});
    const ready=(await report.snapshot(owner)).students[0]!;
    assert.equal(ready.canAssignNow,true);assert.equal(ready.availableWindowCount,3);
    await f.dispatch.cycle(evaluator,key(),{});
    const queued=(await report.snapshot(owner)).students[0]!;
    assert.equal(queued.canAssignNow,false);assert.ok(queued.reasons.some(r=>r.code==='RESEARCH_QUEUED'));
    const claim=(await f.dispatch.claim(researcher,key(),{})).assignment!;
    const running=await report.snapshot(owner);
    assert.ok(running.students[0]!.reasons.some(r=>r.code==='RESEARCH_RUNNING'));
    assert.equal(JSON.stringify(running).includes(claim.leaseToken),false);
    const trial=await f.portfolio.submit(researcher,key(),f.submission({id:claim.id,leaseToken:claim.leaseToken}));
    assert.equal((await report.snapshot(owner)).summary.awaitingEvaluation,1);
    await f.portfolio.review(evaluator,key(),{trialId:trial.id});
    const done=await report.snapshot(owner);
    assert.equal(done.students[0]!.availableWindowCount,1);
    assert.ok(done.students[0]!.reasons.some(r=>r.code==='DAILY_ASSIGNMENT_CAP'));
    assert.equal(done.summary.readyForAssignment,0);
    assert.equal(done.dispatch.remaining.daily,0);
  }finally{await f.db.close();}
});

test('owner report surfaces expired and invalid work without reconciling it or hiding halt state',async()=>{
  const f=await setup();try{
    const report=new OrganisationReport(f.db);
    await f.configure();await f.dispatch.cycle(evaluator,key(),{});
    const claim=(await f.dispatch.claim(researcher,key(),{})).assignment!;
    await f.db.transaction(tx=>tx.query("UPDATE research_assignments SET lease_until=now()-interval '1 second' WHERE id=$1",[claim.id]));
    await f.org.revoke(owner,key(),{kind:'evidence',targetId:f.evidence.evidenceId,reason:'Withdraw support'});
    await f.ops.control(owner,key(),{halted:true,reason:'Owner inspection'});
    const result=await report.snapshot(owner),codes=result.students[0]!.reasons.map(r=>r.code);
    assert.ok(codes.includes('LEASE_EXPIRED'));assert.ok(codes.includes('CURRICULUM_INVALID'));
    assert.ok(codes.includes('ASSIGNMENT_INELIGIBLE'));assert.ok(codes.includes('SYSTEM_HALTED'));
    assert.equal((await f.dispatch.status(owner)).assignments[0]!.state,'running');
    assert.equal(result.students[0]!.canAssignNow,false);
  }finally{await f.db.close();}
});

async function prepareLearning(f:Awaited<ReturnType<typeof setup>>){
  const learning=new OrganisationalLearning(f.db);
  await f.configure();await f.dispatch.cycle(evaluator,key(),{});
  const claim=(await f.dispatch.claim(researcher,key(),{})).assignment!;
  const trial=await f.portfolio.submit(researcher,key(),f.submission({id:claim.id,leaseToken:claim.leaseToken}));
  await f.portfolio.review(evaluator,key(),{trialId:trial.id});
  await learning.register(owner,key(),{id:'reflection',name:'Versioned factual reflection',engine:'factual-reflection-v1'});
  await learning.configure(owner,key(),{expectedRevision:0,enabled:true,modelId:'reflection',maxPerDay:1,maxLifetime:1});
  return {learning,trial};
}
async function futureDataset(f:Awaited<ReturnType<typeof setup>>,offset=0,favourFirstAssets=false){
  const evidence=await f.createEvidence();
  const assets=favourFirstAssets?['A','B','C','D','E','F','G','H']:['A','B','C','D'];
  const rows=(count:number,start:number,heldout=false)=>Array.from({length:count},(_,i)=>({timestamp:new Date(Date.UTC(2021,0,1+start+i)).toISOString(),
    returns:assets.map((_,a)=>favourFirstAssets?(heldout?(a<4 ? 0.005 : -0.005):0.001):0.001*(a+1))}));
  return f.portfolio.dataset(owner,key(),{evidenceId:evidence.evidenceId,purpose:'example-testing',assets,training:rows(60,0),holdout:rows(20,60+offset,true)});
}

test('learning defaults off, requires separate review, records once and does not change fitness',async()=>{
  const f=await setup();try{
    const idle=new OrganisationalLearning(f.db);
    assert.equal((await idle.cycle(researcher,key(),{})).status,'disabled');
    assert.throws(()=>idle.register(researcher,key(),{id:'bad',name:'Bad',engine:'factual-reflection-v1'}),/not permitted/);
    const {learning}=await prepareLearning(f),before=await f.life.community(owner);
    const command=key(),proposed=await learning.cycle(researcher,command,{});
    assert.equal(proposed.actions.length,1);
    assert.deepEqual(await learning.cycle(researcher,command,{}),proposed);
    assert.equal((await learning.memory(owner,{})).items.length,0);
    assert.equal((await learning.cycle({id:researcher.id,role:'evaluator'},key(),{})).actions.length,0);
    assert.equal((await learning.cycle(evaluator,key(),{})).actions[0]!.action,'verified');
    assert.equal((await learning.memory(owner,{})).items.length,1);
    assert.equal((await learning.cycle(researcher,key(),{})).status,'capacity-reached');
    assert.equal((await learning.cycle(evaluator,key(),{})).actions.length,0);
    assert.deepEqual(await f.life.community(owner),before);
    await assert.rejects(()=>f.db.transaction(tx=>tx.query("UPDATE learning_proposals SET content='altered'")));
  }finally{await f.db.close();}
});

test('shared memory excludes future windows and withdrawn evidence while preserving reviewed history',async()=>{
  const f=await setup();try{
    const {learning}=await prepareLearning(f);
    await learning.cycle(researcher,key(),{});await learning.cycle(evaluator,key(),{});
    assert.throws(()=>learning.memory(researcher,{}),/target dataset/);
    assert.equal((await learning.memory(researcher,{datasetId:f.data.id})).items.length,0);
    const future=await futureDataset(f);
    assert.equal((await learning.memory(researcher,{datasetId:future.id})).items.length,1);
    await f.org.revoke(owner,key(),{kind:'evidence',targetId:f.evidence.evidenceId,reason:'Unreliable memory source'});
    assert.equal((await learning.memory(researcher,{datasetId:future.id})).items.length,0);
    assert.equal((await learning.status(owner)).counts!.historically_verified,1);
  }finally{await f.db.close();}
});

test('model withdrawal rejects pending memory and pause/halt prevent learning mutations',async()=>{
  const f=await setup();try{
    const {learning}=await prepareLearning(f);
    await learning.cycle(researcher,key(),{});
    await learning.revoke(owner,key(),{modelId:'reflection',reason:'Review model contract'});
    assert.equal((await learning.cycle(researcher,key(),{})).status,'model-unavailable');
    await f.ops.control(owner,key(),{halted:true,reason:'Pause for review'});
    assert.equal((await learning.cycle(evaluator,key(),{})).status,'halted');
    await f.ops.control(owner,key(),{halted:false,reason:'Continue review'});
    assert.equal((await learning.cycle(evaluator,key(),{})).actions[0]!.action,'rejected');
    assert.equal((await learning.memory(owner,{})).items.length,0);
    await learning.configure(owner,key(),{expectedRevision:1,enabled:false,modelId:'reflection',maxPerDay:1,maxLifetime:1});
    assert.equal((await learning.cycle(researcher,key(),{})).status,'disabled');
  }finally{await f.db.close();}
});

test('Hermes R&D requests bind identity, context and quota; a recommendation never recruits a bot',async()=>{
  const f=await setup();try{
    const {learning}=await prepareLearning(f),development=new ResearchDevelopment(f.db);
    await learning.cycle(researcher,key(),{});await learning.cycle(evaluator,key(),{});
    const future=await futureDataset(f);
    await assert.rejects(()=>development.request(researcher,key(),{datasetId:future.id,method:'equal_weight'}),/disabled/);
    const policy={enabled:true,model:{name:'existing-model',baseUrl:'http://127.0.0.1:8000/v1'},maxPerDay:1,maxLifetime:1};
    await development.configure(owner,key(),{expectedRevision:0,...policy});
    const command=key(),ticket=await development.request(researcher,command,{datasetId:future.id,method:'equal_weight'});
    assert.deepEqual(await development.request(researcher,command,{datasetId:future.id,method:'equal_weight'}),ticket);
    await assert.rejects(()=>development.request(researcher,key(),{datasetId:future.id,method:'equal_weight'}),/budget exhausted/);
    await assert.rejects(()=>development.preflight({id:'other',role:'researcher'},{requestId:ticket.id}),/Current R&D request/);
    assert.equal((await development.preflight(researcher,{requestId:ticket.id})).authorised,true);
    const proposal={specialty:'new-research-angle',method:'equal_weight',hypothesis:'Test a distinct regime across future windows',expectedContribution:'Investigate stability',risks:['Example data does not generalise'],memoryIds:[ticket.context.memories[0]!.id]};
    const body={requestId:ticket.id,contextHash:ticket.contextHash,proposal};
    const submitKey=key();await development.submit(researcher,submitKey,body);
    assert.deepEqual(await development.submit(researcher,submitKey,body),{id:ticket.id,state:'awaiting-review',recruitmentAllowed:false});
    await assert.rejects(()=>development.review({id:researcher.id,role:'evaluator'},key(),{requestId:ticket.id,decision:'recommended',reason:'Self-review'}),/Independent/);
    const botsBefore=await f.org.list(owner);
    const reviewed=await development.review(evaluator,key(),{requestId:ticket.id,decision:'recommended',reason:'Hypothesis worth a separate controlled experiment'});
    assert.equal(reviewed.recruitmentAllowed,false);assert.deepEqual(await f.org.list(owner),botsBefore);
  }finally{await f.db.close();}
});

test('R&D preflight and submission honour withdrawal of authorisation after a request',async()=>{
  const f=await setup();try{
    const {learning}=await prepareLearning(f),development=new ResearchDevelopment(f.db);
    await learning.cycle(researcher,key(),{});await learning.cycle(evaluator,key(),{});
    const future=await futureDataset(f),policy={enabled:true,model:{name:'existing-model',baseUrl:'http://127.0.0.1:8000/v1'},maxPerDay:1,maxLifetime:1};
    await development.configure(owner,key(),{expectedRevision:0,...policy});
    const ticket=await development.request(researcher,key(),{datasetId:future.id,method:'equal_weight'});
    await learning.revoke(owner,key(),{modelId:'reflection',reason:'Withdraw memory engine'});
    await assert.rejects(()=>development.preflight(researcher,{requestId:ticket.id}),/memory support changed/);
    const proposal={specialty:'new-angle',method:'equal_weight',hypothesis:'Test',expectedContribution:'Knowledge',risks:['Risk'],memoryIds:[ticket.context.memories[0]!.id]};
    await assert.rejects(()=>development.submit(researcher,key(),{requestId:ticket.id,contextHash:ticket.contextHash,proposal}),/unavailable or unapproved/);
    await development.configure(owner,key(),{expectedRevision:1,...policy,enabled:false});
    await assert.rejects(()=>development.preflight(researcher,{requestId:ticket.id}),/changed or paused/);
  }finally{await f.db.close();}
});

async function prepareExperiment(f:Awaited<ReturnType<typeof setup>>,favourFirstAssets=false){
  const {learning}=await prepareLearning(f),development=new ResearchDevelopment(f.db),experiments=new DevelopmentExperiments(f.db);
  await learning.cycle(researcher,key(),{});await learning.cycle(evaluator,key(),{});
  const datasets=[await futureDataset(f,0,favourFirstAssets),await futureDataset(f,30,favourFirstAssets),await futureDataset(f,60,favourFirstAssets)];
  await development.configure(owner,key(),{expectedRevision:0,enabled:true,model:{name:'fixture-model',baseUrl:'http://127.0.0.1:8000/v1'},maxPerDay:1,maxLifetime:1});
  const ticket=await development.request(researcher,key(),{datasetId:datasets[0]!.id,method:f.method});
  await development.submit(researcher,key(),{requestId:ticket.id,contextHash:ticket.contextHash,proposal:{specialty:'regime-research',method:f.method,
    hypothesis:'Assess stability on later windows',expectedContribution:'Measure baseline stability',risks:['Example results'],memoryIds:[ticket.context.memories[0]!.id]}});
  await development.review(evaluator,key(),{requestId:ticket.id,decision:'recommended',reason:'Pre-register a diagnostic experiment'});
  await f.configure({datasetIds:datasets.map(d=>d.id)});
  const body={requestId:ticket.id,botId:f.botId,operationalDefinition:'Compare the declared allocation method across all three windows against its baseline',
    datasetIds:datasets.map(d=>d.id),thresholds:{minMeanRewardBps:0,maxDrawdownBps:1000,minPositiveWindows:1}};
  return {learning,development,experiments,datasets,body};
}

test('R&D experiment fixes its plan before work and rejects changed, reused and overlapping windows',async()=>{
  const f=await setup();try{
    const {experiments,datasets,body}=await prepareExperiment(f);
    assert.throws(()=>experiments.register(researcher,key(),body),/not permitted/);
    await assert.rejects(()=>experiments.register(owner,key(),{...body,datasetIds:[f.data.id,datasets[1]!.id,datasets[2]!.id]}),/dispatch pool/);
    const overlap=await futureDataset(f,10);
    await f.configure({datasetIds:[...body.datasetIds,overlap.id]});
    await assert.rejects(()=>experiments.register(owner,key(),{...body,datasetIds:[datasets[0]!.id,overlap.id,datasets[2]!.id]}),/must not overlap/);
    const command=key(),plan=await experiments.register(owner,command,body);
    assert.deepEqual(await experiments.register(owner,command,body),plan);
    await assert.rejects(()=>experiments.register(owner,command,{...body,operationalDefinition:'Change after registration'}),/reused with different input/);
    await assert.rejects(()=>experiments.register(owner,key(),body),/active experiment/);
    await assert.rejects(()=>f.db.transaction(tx=>tx.query("UPDATE development_experiments SET operational_definition='changed' WHERE id=$1",[plan.id])));
    await experiments.cancel(owner,key(),{experimentId:plan.id,reason:'End this experiment'});
    await assert.rejects(()=>experiments.register(owner,key(),body),/already assigned, tested or registered/);
  }finally{await f.db.close();}
});

test('R&D assessment includes every planned result exactly once without a second fitness reward',async()=>{
  const f=await setup();try{
    const {experiments,datasets,body,learning}=await prepareExperiment(f);
    const plan=await experiments.register(owner,key(),body),before=await f.life.community(owner);
    for(let i=0;i<datasets.length;i++){
      await f.dispatch.cycle(evaluator,key(),{});
      const claim=(await f.dispatch.claim(researcher,key(),{})).assignment!;
      const dataset=datasets.find(d=>d.id===claim.datasetId)!;
      const trial=await f.portfolio.submit(researcher,key(),{botId:f.botId,datasetId:dataset.id,datasetDigest:dataset.digest,method:'equal_weight',weights:[.25,.25,.25,.25],assignment:{id:claim.id,leaseToken:claim.leaseToken}});
      await f.portfolio.review(evaluator,key(),{trialId:trial.id});
      if(i<2)assert.equal((await experiments.cycle(evaluator,key(),{})).actions[0]!.status,'awaiting-results');
    }
    assert.equal((await experiments.cycle({id:researcher.id,role:'evaluator'},key(),{})).actions[0]!.status,'independent-evaluator-required');
    const command=key(),result=await experiments.cycle(evaluator,command,{});
    assert.equal(result.actions[0]!.outcome,'not-supported');
    assert.deepEqual(await experiments.cycle(evaluator,command,{}),result);
    assert.equal((await experiments.cycle(evaluator,key(),{})).actions.length,0);
    const historical=(await experiments.status(owner)).items[0]!;
    assert.equal(historical.report.windowCount,3);assert.equal(historical.report.positiveWindows,0);
    assert.equal(historical.report.recruitmentAllowed,false);assert.equal(historical.supportCurrent,true);
    const report=await new OrganisationReport(f.db).snapshot(owner);
    assert.equal(report.development.experiments!.registered,1);assert.equal(report.development.experiments!.not_supported,1);
    assert.equal(report.development.experiments!.pending,0);
    assert.deepEqual(await f.life.community(owner),before);
    await assert.rejects(()=>experiments.cancel(owner,key(),{experimentId:plan.id,reason:'Erase negative outcome'}),/unassessed/);
    await learning.revoke(owner,key(),{modelId:'reflection',reason:'Withdraw support after assessment'});
    const withdrawn=(await experiments.status(owner)).items[0]!;
    assert.equal(withdrawn.supportCurrent,false);assert.deepEqual(withdrawn.report,historical.report);
    assert.equal((await f.treasury.snapshot(owner)).wallet1Paise,'0');
  }finally{await f.db.close();}
});

test('R&D experiment honours halt, missing support and owner cancellation without erasing its plan',async()=>{
  const f=await setup();try{
    const {experiments,body,learning}=await prepareExperiment(f);
    await f.ops.control(owner,key(),{halted:true,reason:'Pause'});
    await assert.rejects(()=>experiments.register(owner,key(),body),/halted/);
    assert.equal((await experiments.cycle(evaluator,key(),{})).status,'halted');
    await f.ops.control(owner,key(),{halted:false,reason:'Resume'});
    const plan=await experiments.register(owner,key(),body);
    await learning.revoke(owner,key(),{modelId:'reflection',reason:'Invalidate supporting memory'});
    assert.equal((await experiments.cycle(evaluator,key(),{})).actions[0]!.status,'support-withdrawn');
    await experiments.cancel(owner,key(),{experimentId:plan.id,reason:'Retain failed research for future review'});
    assert.equal((await experiments.cycle(evaluator,key(),{})).actions.length,0);
    assert.equal((await experiments.status(owner)).items[0]!.cancellation_reason,'Retain failed research for future review');
    assert.equal((await f.ops.verifyAudit(owner)).valid,true);
  }finally{await f.db.close();}
});

test('positive example diagnostics remain research-only and consume previously registered periods',async()=>{
  const f=await setup('minimum_variance');try{
    const {experiments,datasets,body}=await prepareExperiment(f,true);
    await experiments.register(owner,key(),{...body,thresholds:{...body.thresholds,minPositiveWindows:3}});
    for(const dataset of datasets){
      await f.dispatch.cycle(evaluator,key(),{});
      const claim=(await f.dispatch.claim(researcher,key(),{})).assignment!;
      assert.equal(claim.datasetId,dataset.id);
      // Explicit synthetic candidate weights exercise the backend gate, not a skfolio fitting claim.
      const trial=await f.portfolio.submit(researcher,key(),{botId:f.botId,datasetId:dataset.id,datasetDigest:dataset.digest,method:f.method,
        weights:[.25,.25,.25,.25,0,0,0,0],assignment:{id:claim.id,leaseToken:claim.leaseToken}});
      await f.portfolio.review(evaluator,key(),{trialId:trial.id});
    }
    assert.equal((await experiments.cycle(evaluator,key(),{})).actions[0]!.outcome,'supported-for-further-research');
    const result=(await experiments.status(owner)).items[0]!;
    assert.equal(result.report.positiveWindows,3);assert.equal(result.report.tradingAllowed,false);assert.equal(result.report.newFitnessReward,false);
    const bot=(await f.org.list(owner)).find(b=>b.id===f.botId)!;
    assert.equal(bot.state,'college');
    const budget=await f.db.transaction(tx=>tx.query('SELECT budget_paise::text AS budget FROM bots WHERE id=$1',[f.botId]));
    assert.equal(budget.rows[0]!.budget,'0');
    assert.equal((await f.life.community(owner))[0]!.reputation,0);
    const lastEvidence=await f.db.transaction(tx=>tx.query('SELECT evidence_id FROM portfolio_datasets WHERE id=$1',[datasets[2]!.id]));
    await f.org.revoke(owner,key(),{kind:'evidence',targetId:lastEvidence.rows[0]!.evidence_id,reason:'Withdraw one required window'});
    assert.equal((await experiments.status(owner)).items[0]!.supportCurrent,false);
  }finally{await f.db.close();}
});
