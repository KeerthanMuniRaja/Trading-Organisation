import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, owner, researcher, evaluator, trader, key } from './helpers.js';

test('incident findings require independent review, preserve corrections and never resume operations',async()=>{
  const f=await fixture();
  try{
    const {evidenceId}=await f.evidence();
    const incident=await f.ops.incident(researcher,key(),{description:'Fixture critical failure',severity:'critical'});
    const findings=f.ops.findings();
    const input={incidentId:incident.id,evidenceId,rootCause:'Hypothesis: stale input',correctiveAction:'Reject stale input',prevention:'Add regression coverage',verificationPlan:'Replay stale input and confirm rejection'};
    assert.throws(()=>findings.propose(trader,key(),input),/Operation not permitted/);
    const k=key(),a=await findings.propose(researcher,k,input);
    assert.equal((await findings.propose(researcher,k,input)).id,a.id);
    await assert.rejects(findings.propose(researcher,key(),input),/pending/);
    await assert.rejects(f.ops.resolve(owner,key(),{incidentId:incident.id,evidenceId}),/latest/);
    await assert.rejects(findings.review({...researcher,role:'evaluator'},key(),{findingId:a.id,decision:'accepted',reason:'self'}),/Reviewer/);
    await findings.review(evaluator,key(),{findingId:a.id,decision:'rejected',reason:'Need stronger verification'});
    await assert.rejects(findings.review(owner,key(),{findingId:a.id,decision:'accepted',reason:'overwrite'}),/already reviewed/);
    const b=await findings.propose(researcher,key(),{...input,verificationPlan:'Add fresh failure and recovery tests'});
    await findings.review(evaluator,key(),{findingId:b.id,decision:'accepted',reason:'Evidence supports this bounded finding'});
    const wrong=await f.evidence();
    await assert.rejects(f.ops.resolve(owner,key(),{incidentId:incident.id,evidenceId:wrong.evidenceId}),/latest/);
    await f.ops.resolve(owner,key(),{incidentId:incident.id,evidenceId});
    assert.equal((await f.ops.status(owner)).control!.halted,true);
    assert.equal((await findings.list(owner,{incidentId:incident.id})).findings.length,2);
    await assert.rejects(findings.propose(researcher,key(),input),/Open incident/);
    await f.ops.control(owner,key(),{halted:false,reason:'Owner reviewed recovery'});
    assert.equal((await f.ops.verifyAudit(owner)).valid,true);
  }finally{await f.db.close();}
});
test('source withdrawal blocks accepted findings from resolving an incident',async()=>{
  const f=await fixture();try{
    const {evidenceId,sourceId}=await f.evidence();
    const incident=await f.ops.incident(researcher,key(),{description:'Fixture',severity:'warning'});
    const finding=await f.ops.findings().propose(owner,key(),{incidentId:incident.id,evidenceId,rootCause:'Cause',correctiveAction:'Action',prevention:'Prevention',verificationPlan:'Check'});
    await assert.rejects(f.ops.findings().review({...researcher,role:'evaluator'},key(),{findingId:finding.id,decision:'accepted',reason:'Reporter review'}),/Reviewer/);
    await f.ops.findings().review(evaluator,key(),{findingId:finding.id,decision:'accepted',reason:'Reviewed'});
    await f.org.revoke(owner,key(),{kind:'source',targetId:sourceId,reason:'Source no longer reliable'});
    await assert.rejects(f.ops.resolve(owner,key(),{incidentId:incident.id,evidenceId}),/Verified evidence/);
    assert.equal((await f.ops.findings().list(owner,{incidentId:incident.id})).findings[0]!.support_current,false);
  }finally{await f.db.close();}
});
