import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SkillExperiments } from '../src/skill-experiments.js';
import { AcademySkills } from '../src/skills.js';
import { Challenge, Answers } from '../src/skill-contract.js';
import { createApp } from '../src/app.js';
import { fixture, owner, researcher, evaluator, key } from './helpers.js';

const baseline={name:'fixture',version:'1',kind:'deterministic' as const,sourceSha256:'a'.repeat(64)};
const candidate={...baseline,version:'2',sourceSha256:'b'.repeat(64)};
const plan={baseline,candidate,researcherId:researcher.id,caseCount:8,
  criteria:{minCandidatePassBps:10000,maxRegressions:0,minImprovements:1},purpose:'Synthetic paired fixture'};
function answer(c:Challenge):Answers{
  const peaks=c.equityPaise.map((_,i)=>Math.max(...c.equityPaise.slice(0,i+1)));
  return {netProfitPaise:c.grossProfitPaise-c.feesPaise-c.slippagePaise,
    maxDrawdownBps:Math.max(...c.equityPaise.map((n,i)=>10000*(peaks[i]!-n)/peaks[i]!)),
    eligibleRecordIds:c.records.filter(r=>r.eventAt<=c.cutoff&&r.availableAt<=c.cutoff).map(r=>r.id),
    action:!c.control.halted&&c.control.evidenceVerified&&c.control.budget>=c.control.required?'research':'wait'};
}
async function setup(){
  const f=await fixture(),experiments=new SkillExperiments(f.db),skills=new AcademySkills(f.db);
  try{await skills.configure(owner,key(),{expectedRevision:0,enabled:true,maxPerDay:12,maxLifetime:100});
    return {...f,experiments,skills};
  }catch(error){await f.db.close();throw error;}
}
async function prepare(experiments:SkillExperiments){
  const registered=await experiments.register(owner,key(),plan);
  const identity={experimentId:registered.experimentId,baselineHash:registered.baselineHash,candidateHash:registered.candidateHash};
  const work=await experiments.work(researcher,identity);
  const payload={...identity,planHash:work.planHash as string,
    results:(work.cases as {id:string;challenge:Challenge}[]).map(q=>({caseId:q.id,
      baseline:{...answer(q.challenge),netProfitPaise:999999},candidate:answer(q.challenge)}))};
  return {registered,identity,work,payload};
}

test('paired plans freeze versions and criteria; independent grading counts every check without financial or school effects',async()=>{
  const f=await setup();
  try{
    const registrationKey=key(),a=await f.experiments.register(owner,registrationKey,plan);
    assert.deepEqual(await f.experiments.register(owner,registrationKey,plan),a);
    await assert.rejects(()=>f.experiments.register(owner,registrationKey,{...plan,caseCount:12}),/different input/);
    const identity={experimentId:a.experimentId,baselineHash:a.baselineHash,candidateHash:a.candidateHash};
    const w=await f.experiments.work(researcher,identity);
    assert.deepEqual(await f.experiments.work(researcher,identity),w);
    const questions=w.cases as {id:string;challenge:Challenge}[];
    assert.equal(questions.length,8);
    assert.equal(questions.filter(q=>answer(q.challenge).action==='research').length,2);
    const input={...identity,planHash:w.planHash,results:questions.map(q=>({caseId:q.id,
      baseline:{...answer(q.challenge),netProfitPaise:999999},candidate:answer(q.challenge)}))};
    const k=key();await f.experiments.submit(researcher,k,input);await f.experiments.submit(researcher,k,input);
    await assert.rejects(()=>f.experiments.review({...evaluator,id:researcher.id},key(),{experimentId:a.experimentId}),/Independent/);
    await assert.rejects(()=>f.experiments.review({...evaluator,id:owner.id},key(),{experimentId:a.experimentId}),/Independent/);
    const report=await f.experiments.review(evaluator,key(),{experimentId:a.experimentId});
    assert.equal(report.outcome,'meets-criteria');assert.equal(report.promotionAllowed,false);
    assert.deepEqual(report.totals,{baselinePassed:24,candidatePassed:32,improvements:8,regressions:0,totalChecks:32});
    assert.equal(report.bySkill.costs.improvements,8);assert.equal(report.cases.length,8);
    assert.deepEqual(await f.experiments.review(evaluator,key(),{experimentId:a.experimentId}),report);
    assert.equal((await f.experiments.status(owner)).experiments[0]!.state,'meets-criteria');
    for(const table of ['skill_experiments','skill_experiment_submissions','skill_experiment_reviews'])
      await assert.rejects(()=>f.db.transaction(tx=>tx.query('DELETE FROM '+table)));
    const counts=await f.db.transaction(async tx=>Promise.all(['skill_attempts','bots','lessons'].map(async table=>(await tx.query('SELECT count(*)::int AS n FROM '+table)).rows[0]!.n)));
    assert.deepEqual(counts,[0,0,0]);assert.equal((await f.treasury.snapshot(owner)).wallet1Paise,'0');
    assert.equal((await f.ops.verifyAudit(owner)).valid,true);
  }finally{await f.db.close();}
});

test('paired work refuses version substitution, unassigned authors, omitted cases, duplicates, forged grades and changed answers',async()=>{
  const f=await setup();
  try{
    const p=await prepare(f.experiments);
    await assert.rejects(()=>f.experiments.work({...researcher,id:'other'},p.identity),/Assigned/);
    await assert.rejects(()=>f.experiments.work(researcher,{...p.identity,candidateHash:'c'.repeat(64)}),/mismatch/);
    await assert.rejects(()=>f.experiments.submit(researcher,key(),{...p.payload,planHash:'c'.repeat(64)}),/mismatch/);
    const duplicate=[...p.payload.results];duplicate[7]=duplicate[0]!;
    await assert.rejects(()=>f.experiments.submit(researcher,key(),{...p.payload,results:duplicate}),/exactly once/);
    assert.throws(()=>f.experiments.submit(researcher,key(),{...p.payload,results:p.payload.results.slice(1)}));
    assert.throws(()=>f.experiments.submit(researcher,key(),{...p.payload,outcome:'meets-criteria'}));
    await assert.rejects(()=>f.experiments.review(evaluator,key(),{experimentId:p.identity.experimentId}),/Complete/);
    await f.experiments.submit(researcher,key(),p.payload);
    const changed=structuredClone(p.payload);changed.results[0]!.candidate.netProfitPaise=999999;
    await assert.rejects(()=>f.experiments.submit(researcher,key(),changed),/already fixed/);
    await assert.rejects(()=>f.experiments.work(researcher,p.identity),/already submitted/);
    const report=await f.experiments.review(evaluator,key(),{experimentId:p.identity.experimentId});
    assert.equal(report.totals.candidatePassed,32);
  }finally{await f.db.close();}
});

test('paired regression cannot hide behind improvements and incomplete experiments stay visible within capacity',async()=>{
  const f=await setup();
  try{
    const p=await prepare(f.experiments);
    // Eight cost improvements still cannot offset one abstention regression under this plan.
    const first=p.payload.results[0]!;first.candidate.action=first.candidate.action==='wait'?'research':'wait';
    await f.experiments.submit(researcher,key(),p.payload);
    const report=await f.experiments.review(evaluator,key(),{experimentId:p.identity.experimentId});
    assert.equal(report.outcome,'below-criteria');assert.equal(report.totals.improvements,8);assert.equal(report.totals.regressions,1);
    for(let i=0;i<3;i++)await f.experiments.register(owner,key(),plan);
    await assert.rejects(()=>f.experiments.register(owner,key(),plan),/capacity/);
    const states=(await f.experiments.status(owner)).experiments.map(p=>p.state);
    assert.equal(states.filter(s=>s==='awaiting-submission').length,3);assert.ok(states.includes('below-criteria'));
  }finally{await f.db.close();}
});

test('paired halt, cancellation and policy withdrawal preserve history and block unsupported results',async()=>{
  const f=await setup();
  try{
    const p=await prepare(f.experiments);
    await f.db.transaction(tx=>tx.query('UPDATE system_lock SET halted=true WHERE id=1'));
    await assert.rejects(()=>f.experiments.work(researcher,p.identity),/halted/);
    await assert.rejects(()=>f.experiments.submit(researcher,key(),p.payload),/halted/);
    await f.experiments.cancel(owner,key(),{experimentId:p.identity.experimentId,reason:'Stop this fixture'});
    await f.db.transaction(tx=>tx.query('UPDATE system_lock SET halted=false WHERE id=1'));
    await assert.rejects(()=>f.experiments.work(researcher,p.identity),/closed/);
    await assert.rejects(()=>f.db.transaction(tx=>tx.query('DELETE FROM skill_experiment_cancellations')));
    const q=await prepare(f.experiments);await f.experiments.submit(researcher,key(),q.payload);
    await f.skills.configure(owner,key(),{expectedRevision:1,enabled:false,maxPerDay:12,maxLifetime:100});
    const report=await f.experiments.review(evaluator,key(),{experimentId:q.identity.experimentId});
    assert.equal(report.outcome,'invalidated');assert.equal(report.promotionAllowed,false);assert.equal(report.totals,undefined);
    const states=(await f.experiments.status(owner)).experiments.map(p=>p.state);
    assert.ok(states.includes('cancelled'));assert.ok(states.includes('invalidated'));
  }finally{await f.db.close();}
});

test('expired paired work cannot submit or reset its history and no incomplete version passes',async()=>{
  const f=await setup();
  try{
    const p=await prepare(f.experiments),expired=randomUUID();
    // Immutable historical fixture: no protected row or system clock is changed.
    await f.db.transaction(tx=>tx.query(`INSERT INTO skill_experiments(id,author,researcher,baseline_hash,candidate_hash,
      policy_revision,rubric,criteria,cases,plan_hash,purpose,created_at,expires_at)
      SELECT $1,author,researcher,baseline_hash,candidate_hash,policy_revision,rubric,criteria,cases,$2,purpose,
      clock_timestamp()-interval '2 days',clock_timestamp()-interval '1 day' FROM skill_experiments WHERE id=$3`,[expired,'e'.repeat(64),p.identity.experimentId]));
    await assert.rejects(()=>f.experiments.work(researcher,{...p.identity,experimentId:expired}),/expired/);
    await assert.rejects(()=>f.experiments.submit(researcher,key(),{...p.payload,experimentId:expired,planHash:'e'.repeat(64)}),/expired/);
    await assert.rejects(()=>f.experiments.review(evaluator,key(),{experimentId:expired}),/Complete/);
    const row=(await f.experiments.status(owner)).experiments.find(p=>p.id===expired)!;
    assert.equal(row.state,'expired');assert.equal(row.report,null);assert.equal(row.submitted,false);
  }finally{await f.db.close();}
});

test('cancelled and historical paired plans keep their daily and lifetime capacity cost',async()=>{
  const f=await setup();
  try{
    let first='';
    for(let i=0;i<10;i++){
      const p=await f.experiments.register(owner,key(),plan);first ||= p.experimentId;
      await f.experiments.cancel(owner,key(),{experimentId:p.experimentId,reason:'Cancellation does not reset budget'});
    }
    await assert.rejects(()=>f.experiments.register(owner,key(),plan),/capacity/);
    // Add previously expired history to exercise the lifetime boundary without resetting any row.
    await f.db.transaction(async tx=>{
      for(let i=0;i<90;i++)await tx.query(`INSERT INTO skill_experiments(id,author,researcher,baseline_hash,candidate_hash,
        policy_revision,rubric,criteria,cases,plan_hash,purpose,created_at,expires_at)
        SELECT $1,author,researcher,baseline_hash,candidate_hash,policy_revision,rubric,criteria,cases,$2,purpose,
        clock_timestamp()-interval '3 days',clock_timestamp()-interval '2 days' FROM skill_experiments WHERE id=$3`,[randomUUID(),i.toString(16).padStart(64,'0'),first]);
    });
    await f.skills.configure(owner,key(),{expectedRevision:1,enabled:true,maxPerDay:100,maxLifetime:1000});
    await assert.rejects(()=>f.experiments.register(owner,key(),plan),/capacity/);
    assert.equal((await f.experiments.status(owner)).experiments.length,100);
  }finally{await f.db.close();}
});

test('paired HTTP routes enforce role boundaries and strict plans with no question disclosure in owner summaries',async()=>{
  const f=await fixture(),app=await createApp(f.cfg,f.db,true);
  try{
    await app.listen(0,'127.0.0.1');const base=await app.getUrl();
    const call=(route:string,role:string,body?:unknown)=>fetch(base+'/v1/skills'+route,{method:body===undefined?'GET':'POST',
      headers:{Authorization:'Bearer '+f.cfg.principals.find(p=>p.role===role)!.token,'Content-Type':'application/json','Idempotency-Key':key()},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    assert.equal((await call('/experiments','researcher',plan)).status,403);
    assert.equal((await call('/experiments','owner',plan)).status,409);
    assert.equal((await call('/policy','owner',{expectedRevision:0,enabled:true,maxPerDay:12,maxLifetime:100})).status,201);
    assert.equal((await call('/experiments','owner',{...plan,criteria:{...plan.criteria,autoDeploy:true}})).status,400);
    const registration=await call('/experiments','owner',plan);assert.equal(registration.status,201);
    const registered=await registration.json() as any;
    const identity={experimentId:registered.experimentId,baselineHash:registered.baselineHash,candidateHash:registered.candidateHash};
    assert.equal((await call('/experiments','researcher')).status,403);
    assert.equal((await call('/experiments/work','owner',identity)).status,403);
    assert.equal((await call('/experiments/reviews','researcher',{experimentId:registered.experimentId})).status,403);
    assert.equal((await call('/experiments/submissions','evaluator',{})).status,403);
    const status=await (await call('/experiments','owner')).json() as any;
    assert.equal(status.experiments[0].cases,undefined);
    assert.equal((await call('/experiments/work','researcher',identity)).status,201);
    assert.equal((await call('/experiments/cancellations','owner',{experimentId:registered.experimentId,reason:'End HTTP fixture'})).status,201);
  }finally{await app.close();await f.db.close();}
});
