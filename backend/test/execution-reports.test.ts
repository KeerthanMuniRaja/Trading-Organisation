import test from 'node:test';
import assert from 'node:assert/strict';
import { SkillExperiments } from '../src/skill-experiments.js';
import { AcademySkills } from '../src/skills.js';
import { fixture, owner, researcher, key } from './helpers.js';

async function setup(){
  const f=await fixture(),service=new SkillExperiments(f.db);
  await new AcademySkills(f.db).configure(owner,key(),{expectedRevision:0,enabled:true,maxPerDay:12,maxLifetime:100});
  const producer={name:'report-fixture',version:'1',kind:'deterministic',sourceSha256:'a'.repeat(64)};
  const p=await service.register(owner,key(),{baseline:producer,candidate:{...producer,version:'2',sourceSha256:'b'.repeat(64)},
    researcherId:researcher.id,caseCount:8,criteria:{minCandidatePassBps:10000,maxRegressions:0,minImprovements:1},purpose:'Report fixture'});
  const identity={experimentId:p.experimentId,planHash:p.planHash,baselineHash:p.baselineHash,candidateHash:p.candidateHash,mode:'trusted-local-process-only'};
  return {...f,service,identity};
}
const event=(sequence:number,state:string,code='NONE',attempt=1,stage='baseline')=>({sequence,state,code,attempt,stage});

test('execution observations retry, deduplicate and remain distinct from backend facts',async()=>{
  const f=await setup();
  try{
    const events=[event(1,'started'),event(2,'failed','TIMEOUT'),event(3,'started','NONE',2),event(4,'succeeded','NONE',2),event(5,'confirmed','NONE',1,'submission')];
    assert.equal((await f.service.reportExecution(researcher,key(),{...f.identity,events})).recorded,5);
    const before=await f.db.transaction(async tx=>(await tx.query('SELECT count(*) AS n FROM notifications')).rows[0]!.n);
    assert.equal((await f.service.reportExecution(researcher,key(),{...f.identity,events})).recorded,0);
    assert.equal(await f.db.transaction(async tx=>(await tx.query('SELECT count(*) AS n FROM notifications')).rows[0]!.n),before);
    const status=await f.service.executionStatus(owner);
    assert.equal(status.verifiedExecution,false);assert.equal(status.liveness,'not-established');
    assert.equal(status.streams[0]!.backend_submission_received,false);
    assert.equal(status.streams[0]!.backend_review_outcome,null);
    assert.equal(status.streams[0]!.observations.length,5);
    await assert.rejects(()=>f.service.reportExecution(researcher,key(),{...f.identity,events:[event(6,'failed','TIMEOUT',2)]}),/already final/);
    await assert.rejects(()=>f.service.reportExecution(researcher,key(),{...f.identity,events:[event(2,'succeeded')]}),/rewritten/);
    for(const table of ['skill_execution_events','skill_execution_streams'])await assert.rejects(()=>f.db.transaction(tx=>tx.query('DELETE FROM '+table)));
    assert.equal((await f.ops.verifyAudit(owner)).valid,true);
    assert.equal((await f.treasury.snapshot(owner)).wallet1Paise,'0');
  }finally{await f.db.close();}
});

test('execution reporting enforces identity, ordering and a closed payload schema',async()=>{
  const f=await setup();
  try{
    const input={...f.identity,events:[event(1,'started')]};
    assert.throws(()=>f.service.reportExecution(owner,key(),input));
    assert.throws(()=>f.service.executionStatus(researcher));
    assert.throws(()=>f.service.reportExecution(researcher,key(),{...input,error:'sensitive path'}));
    assert.throws(()=>f.service.reportExecution(researcher,key(),{...input,events:[event(1,'started','TIMEOUT')]}));
    assert.throws(()=>f.service.reportExecution(researcher,key(),{...input,mode:'docker-linux-container'}));
    await assert.rejects(()=>f.service.reportExecution({...researcher,id:'other'},key(),input),/Assigned/);
    await assert.rejects(()=>f.service.reportExecution(researcher,key(),{...input,planHash:'c'.repeat(64)}),/mismatch/);
    await assert.rejects(()=>f.service.reportExecution(researcher,key(),{...input,events:[event(2,'started')]}),/contiguous/);
    await assert.rejects(()=>f.service.reportExecution(researcher,key(),{...input,events:[event(1,'started','NONE',2)]}),/Retry/);
    await f.service.reportExecution(researcher,key(),input);
    await assert.rejects(()=>f.service.reportExecution(researcher,key(),{...input,mode:'docker-linux-container',imageId:'sha256:'+'d'.repeat(64)}),/identity changed/);
    await assert.rejects(()=>f.service.reportExecution(researcher,key(),{...input,events:[event(2,'succeeded'),event(4,'started','NONE',1,'candidate')]}),/contiguous/);
    assert.equal((await f.service.executionStatus(owner)).streams[0]!.observations.length,1);
  }finally{await f.db.close();}
});

test('halted and cancelled work can still report cleanup failure without restoring authority',async()=>{
  const f=await setup();
  try{
    await f.service.cancel(owner,key(),{experimentId:f.identity.experimentId,reason:'Stop fixture'});
    await f.db.transaction(tx=>tx.query('UPDATE system_lock SET halted=true WHERE id=1'));
    await f.service.reportExecution(researcher,key(),{...f.identity,events:[event(1,'started'),event(2,'failed','CLEANUP_UNCONFIRMED')]});
    assert.equal((await f.service.executionStatus(owner)).streams[0]!.cancelled,true);
    await assert.rejects(()=>f.service.work(researcher,{experimentId:f.identity.experimentId,baselineHash:f.identity.baselineHash,candidateHash:f.identity.candidateHash}));
  }finally{await f.db.close();}
});
