import test from 'node:test';
import assert from 'node:assert/strict';
import { SkillExperiments } from '../src/skill-experiments.js';
import { AcademySkills } from '../src/skills.js';
import { createApp } from '../src/app.js';
import { fixture, owner, researcher, evaluator, key } from './helpers.js';

async function setup(review=true,fail=false){
  const f=await fixture(),s=new SkillExperiments(f.db),skills=new AcademySkills(f.db);
  await skills.configure(owner,key(),{expectedRevision:0,enabled:true,maxPerDay:12,maxLifetime:100});
  const producer={name:'approval-fixture',version:'1',kind:'deterministic',sourceSha256:'a'.repeat(64)};
  const p=await s.register(owner,key(),{baseline:producer,candidate:{...producer,version:'2',sourceSha256:'b'.repeat(64)},researcherId:researcher.id,caseCount:8,
    criteria:{minCandidatePassBps:10000,maxRegressions:0,minImprovements:0},purpose:'Approval fixture'});
  const identity={experimentId:p.experimentId,baselineHash:p.baselineHash,candidateHash:p.candidateHash};
  const w=await s.work(researcher,identity);
  const results=w.cases.map((q:any)=>{
    const c=q.challenge,peaks=c.equityPaise.map((_:number,i:number)=>Math.max(...c.equityPaise.slice(0,i+1)));
    const answer={netProfitPaise:c.grossProfitPaise-c.feesPaise-c.slippagePaise,
      maxDrawdownBps:Math.max(...c.equityPaise.map((n:number,i:number)=>10000*(peaks[i]-n)/peaks[i])),
      eligibleRecordIds:c.records.filter((r:any)=>r.eventAt<=c.cutoff&&r.availableAt<=c.cutoff).map((r:any)=>r.id),
      action:!c.control.halted&&c.control.evidenceVerified&&c.control.budget>=c.control.required?'research':'wait'};
    return {caseId:q.id,baseline:answer,candidate:fail?{...answer,netProfitPaise:999999}:answer};
  });
  await s.submit(researcher,key(),{...identity,planHash:p.planHash,results});
  if(review)await s.review(evaluator,key(),{experimentId:p.experimentId});
  return {...f,s,skills,input:{experimentId:p.experimentId,planHash:p.planHash,candidateHash:p.candidateHash,validHours:24,reason:'Further controlled research only'}};
}

test('owner research approval is hash-bound, idempotent and permanently revocable without deployment authority',async()=>{
  const f=await setup();
  try{
    const k=key(),a=await f.s.approveResearch(owner,k,f.input);
    assert.equal(a.deploymentAllowed,false);assert.equal(a.tradingAllowed,false);assert.equal(a.verifiedExecution,false);
    assert.deepEqual(await f.s.approveResearch(owner,k,f.input),a);
    await assert.rejects(()=>f.s.approveResearch(owner,key(),f.input),/already has/);
    assert.equal((await f.s.researchApprovals(owner)).approvals[0]!.current_state,'approved-for-research');
    await f.db.transaction(tx=>tx.query('UPDATE system_lock SET halted=true WHERE id=1'));
    assert.equal((await f.s.researchApprovals(owner)).approvals[0]!.current_state,'halted');
    const revoke={approvalId:a.approvalId,reason:'Withdraw after operational review'};
    await f.s.revokeResearch(owner,key(),revoke);
    await f.s.revokeResearch(owner,key(),revoke);
    await assert.rejects(()=>f.s.revokeResearch(owner,key(),{...revoke,reason:'rewrite'}),/fixed/);
    assert.equal((await f.s.researchApprovals(owner)).approvals[0]!.current_state,'revoked');
    // Original receipt is historical; status remains revoked after idempotent replay.
    assert.deepEqual(await f.s.approveResearch(owner,k,f.input),a);
    for(const table of ['skill_research_approvals','skill_research_revocations'])await assert.rejects(()=>f.db.transaction(tx=>tx.query('DELETE FROM '+table)));
    assert.equal((await f.ops.verifyAudit(owner)).valid,true);
    assert.equal((await f.treasury.snapshot(owner)).wallet1Paise,'0');
  }finally{await f.db.close();}
});

test('approval rejects missing review, wrong identities, halt, policy changes and invalid authority fields',async()=>{
  const f=await setup(false);
  try{
    assert.throws(()=>f.s.approveResearch(researcher,key(),f.input));
    assert.throws(()=>f.s.approveResearch(owner,key(),{...f.input,deploymentAllowed:true}));
    assert.throws(()=>f.s.approveResearch(owner,key(),{...f.input,validHours:169}));
    await assert.rejects(()=>f.s.approveResearch(owner,key(),f.input),/passing experiment/);
    await f.s.review(evaluator,key(),{experimentId:f.input.experimentId});
    await assert.rejects(()=>f.s.approveResearch(owner,key(),{...f.input,candidateHash:'c'.repeat(64)}),/identity mismatch/);
    await assert.rejects(()=>f.s.approveResearch({...owner,id:evaluator.id},key(),f.input),/Independent/);
    await f.db.transaction(tx=>tx.query('UPDATE system_lock SET halted=true WHERE id=1'));
    await assert.rejects(()=>f.s.approveResearch(owner,key(),f.input),/policy support/);
    await f.db.transaction(tx=>tx.query('UPDATE system_lock SET halted=false WHERE id=1'));
    await f.s.approveResearch(owner,key(),f.input);
    await f.skills.configure(owner,key(),{expectedRevision:1,enabled:true,maxPerDay:12,maxLifetime:100});
    assert.equal((await f.s.researchApprovals(owner)).approvals[0]!.current_state,'unsupported');
  }finally{await f.db.close();}
});

test('failed candidates cannot obtain approval',async()=>{
  const f=await setup(true,true);
  try{await assert.rejects(()=>f.s.approveResearch(owner,key(),f.input),/passing experiment/);}
  finally{await f.db.close();}
});

test('research approval HTTP boundaries and expiry remain explicit',async()=>{
  const f=await setup();let app;
  try{
    app=await createApp(f.cfg,f.db,true);await app.listen(0,'127.0.0.1');const base=await app.getUrl();
    const path=base+'/v1/skills/experiments/research-approvals';
    const headers=(role:string)=>({'Authorization':'Bearer '+f.cfg.principals.find(p=>p.role===role)!.token,'Content-Type':'application/json','Idempotency-Key':key()});
    assert.equal((await fetch(path)).status,401);
    assert.equal((await fetch(path,{method:'POST',headers:headers('researcher'),body:JSON.stringify(f.input)})).status,403);
    // An expired historical fixture must never be advertised as a usable approval.
    await f.db.transaction(tx=>tx.query(`INSERT INTO skill_research_approvals(id,experiment_id,owner_id,candidate_hash,plan_hash,policy_revision,reason,expires_at)
      VALUES($1,$2,$3,$4,$5,1,'Expired fixture',clock_timestamp()-interval '1 second')`,
      [crypto.randomUUID(),f.input.experimentId,owner.id,f.input.candidateHash,f.input.planHash]));
    const response=await fetch(path,{headers:headers('evaluator')});assert.equal(response.status,200);
    assert.equal((await response.json()).approvals[0].current_state,'expired');
  }finally{if(app)await app.close();await f.db.close();}
});
