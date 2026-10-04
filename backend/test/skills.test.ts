import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AcademySkills, schoolSkillReady } from '../src/skills.js';
import { SkillRecovery, currentSkillRecovery, schoolSkillBudget } from '../src/skill-recovery.js';
import { digest } from '../src/core.js';
import { SkillDiagnostics } from '../src/skill-diagnostics.js';
import { Answers, Challenge, gradeSkill } from '../src/skill-contract.js';
import { ResearchLifecycle } from '../src/lifecycle.js';
import { OrganisationReport } from '../src/organisation-report.js';
import { createApp } from '../src/app.js';
import { fixture, owner, researcher, evaluator, key } from './helpers.js';

function answer(c:Challenge):Answers {
  const drawdowns=c.equityPaise.map((n,i)=>10000*(Math.max(...c.equityPaise.slice(0,i+1))-n)/Math.max(...c.equityPaise.slice(0,i+1)));
  return {netProfitPaise:c.grossProfitPaise-c.feesPaise-c.slippagePaise,maxDrawdownBps:Math.max(...drawdowns),
    eligibleRecordIds:c.records.filter(r=>r.eventAt<=c.cutoff&&r.availableAt<=c.cutoff).map(r=>r.id),
    action:c.control.halted||!c.control.evidenceVerified||c.control.budget<c.control.required?'wait':'research'};
}
async function setup(){
  const f=await fixture(),skills=new AcademySkills(f.db),life=new ResearchLifecycle(f.db);
  try{
    const evidence=await f.evidence();
    await f.org.bot(owner,key(),{id:'teacher',name:'Curriculum',department:'education',specialty:'basics',method:'lessons',contribution:'Research fundamentals',budgetPaise:'0'});
    const lesson=await f.org.lesson(researcher,key(),{botId:'teacher',content:'Account for costs, information timing, drawdown and owner controls.',evidenceId:evidence.evidenceId});
    await f.org.verifyLesson(evaluator,key(),{lessonId:lesson.id});
    await life.blueprint(owner,key(),{id:'student',name:'Research student',specialty:'basics',method:'equal_weight',contribution:'Baseline allocation',evidenceId:evidence.evidenceId,lessonIds:[lesson.id]});
    const policy=(await life.status(owner)).policy!;
    await life.configure(owner,key(),{expectedRevision:0,rules:{...policy.rules,enabled:true}});
    const born=await life.cycle(evaluator,key(),{}),botId=born.actions[0]!.botId as string;
    await skills.configure(owner,key(),{expectedRevision:0,enabled:true,maxPerDay:12,maxLifetime:100});
    const tick=async()=>{await f.db.transaction(tx=>tx.query("UPDATE lifecycle_policy SET last_cycle_at=now()-interval '2 hours' WHERE id=1"));return life.cycle(evaluator,key(),{});};
    const claim=async()=>{const r=await skills.claim(researcher,key(),{});assert.ok(r.attempt);return r.attempt;};
    return {...f,skills,life,botId,lesson,evidence,tick,claim};
  }catch(e){await f.db.close();throw e;}
}

test('skill rubric measures costs, peak-relative drawdown, availability and abstention independently',()=>{
  const c:Challenge={grossProfitPaise:-300,feesPaise:50,slippagePaise:25,equityPaise:[10000,12000,9000,11000],cutoff:'2020-01-02T00:00:00Z',
    records:[{id:'record-0',eventAt:'2020-01-01T00:00:00Z',availableAt:'2020-01-02T00:00:00Z'},
      {id:'record-1',eventAt:'2020-01-01T00:00:00Z',availableAt:'2020-01-03T00:00:00Z'}],
    control:{halted:false,evidenceVerified:true,budget:10,required:10}};
  const a:Answers={netProfitPaise:-375,maxDrawdownBps:2500,eligibleRecordIds:['record-0'],action:'research'};
  assert.deepEqual(gradeSkill(c,a),{costs:true,drawdown:true,informationTiming:true,abstention:true});
  assert.deepEqual(gradeSkill(c,{...a,netProfitPaise:-300,maxDrawdownBps:1000,eligibleRecordIds:['record-0','record-1'],action:'wait'}),
    {costs:false,drawdown:false,informationTiming:false,abstention:false});
  for(const control of [{...c.control,halted:true},{...c.control,evidenceVerified:false},{...c.control,budget:9}])
    assert.equal(gradeSkill({...c,control},{...a,action:'wait'}).abstention,true);
});

test('managed admission requires a current independently graded pass with immutable evidence and no rewards',async()=>{
  const f=await setup();
  try{
    await f.tick();assert.equal((await f.life.community(owner))[0]!.state,'school');
    assert.ok((await new OrganisationReport(f.db).snapshot(owner)).students[0]!.reasons.some(r=>r.code==='SKILL_ASSESSMENT_REQUIRED'));
    await assert.rejects(()=>f.org.school(owner,key(),{botId:f.botId,lessonIds:[f.lesson.id]}),/assessment pass/);
    const claimKey=key(),a=(await f.skills.claim(researcher,claimKey,{})).attempt!;
    assert.deepEqual((await f.skills.claim(researcher,claimKey,{})).attempt,a);
    assert.equal((await f.claim()).id,a.id);
    const body={attemptId:a.id,answers:answer(a.challenge)};
    await assert.rejects(()=>f.skills.submit({...researcher,id:'other'},key(),body),/Own skill/);
    await f.skills.submit(researcher,key(),body);await f.skills.submit(researcher,key(),body);
    await assert.rejects(()=>f.skills.submit(researcher,key(),{...body,answers:{...body.answers,netProfitPaise:999999}}),/already fixed/);
    assert.equal((await f.skills.cycle({...evaluator,id:researcher.id},key(),{})).actions.length,0);
    assert.equal((await f.skills.cycle(evaluator,key(),{})).actions[0]!.outcome,'passed');
    assert.equal((await f.skills.cycle(evaluator,key(),{})).actions.length,0);
    assert.equal(await f.db.transaction(tx=>schoolSkillReady(tx,f.botId)),true);
    await assert.rejects(()=>f.db.transaction(tx=>tx.query('DELETE FROM skill_reviews')));
    await f.tick();const bot=(await f.life.community(owner))[0]!;
    assert.equal(bot.state,'college');assert.equal(bot.reputation,0);
    assert.equal((await f.treasury.snapshot(owner)).wallet1Paise,'0');
  }finally{await f.db.close();}
});

test('failed attempts are preserved and three lifetime tries cannot be reset by changing policy',async()=>{
  const f=await setup();
  try{
    for(let i=0;i<3;i++){
      const a=await f.claim();await f.skills.submit(researcher,key(),{attemptId:a.id,answers:{...answer(a.challenge),netProfitPaise:999999}});
      assert.equal((await f.skills.cycle(evaluator,key(),{})).actions[0]!.outcome,'failed');
    }
    assert.equal((await f.skills.claim(researcher,key(),{})).status,'idle');
    await f.skills.configure(owner,key(),{expectedRevision:1,enabled:true,maxPerDay:100,maxLifetime:1000});
    assert.equal((await f.skills.claim(researcher,key(),{})).attempt,null);
    await f.tick();assert.equal((await f.life.community(owner))[0]!.state,'school');
    assert.equal((await f.skills.status(owner)).attempts.length,3);
  }finally{await f.db.close();}
});

test('policy changes, revoked curriculum and global halt fence submissions and admission',async()=>{
  const f=await setup();
  try{
    const a=await f.claim();
    await f.skills.configure(owner,key(),{expectedRevision:1,enabled:true,maxPerDay:12,maxLifetime:100});
    await assert.rejects(()=>f.skills.submit(researcher,key(),{attemptId:a.id,answers:answer(a.challenge)}),/policy changed/);
    const b=await f.claim();await f.skills.submit(researcher,key(),{attemptId:b.id,answers:answer(b.challenge)});
    await f.db.transaction(tx=>tx.query('UPDATE system_lock SET halted=true WHERE id=1'));
    assert.equal((await f.skills.cycle(evaluator,key(),{})).status,'halted');
    assert.equal((await f.skills.claim(researcher,key(),{})).status,'halted');
    await f.db.transaction(tx=>tx.query('UPDATE system_lock SET halted=false WHERE id=1'));
    await f.org.revoke(owner,key(),{kind:'evidence',targetId:f.evidence.evidenceId,reason:'Invalid curriculum source'});
    assert.equal((await f.skills.cycle(evaluator,key(),{})).actions[0]!.outcome,'invalidated');
    assert.equal(await f.db.transaction(tx=>schoolSkillReady(tx,f.botId)),false);
  }finally{await f.db.close();}
});

test('expired challenges consume capacity and a revoked pass cannot admit a student',async()=>{
  const f=await setup();
  try{
    const a=await f.claim(),expired=randomUUID();
    await f.db.transaction(tx=>tx.query(`INSERT INTO skill_attempts(id,bot_id,policy_revision,rubric,curriculum,challenge,author,created_at,expires_at)
      SELECT $1,bot_id,policy_revision,rubric,curriculum,challenge,author,clock_timestamp()-interval '5 minutes',clock_timestamp()-interval '3 minutes'
      FROM skill_attempts WHERE id=$2`,[expired,a.id]));
    await assert.rejects(()=>f.skills.submit(researcher,key(),{attemptId:expired,answers:answer(a.challenge)}),/expired/);
    await f.skills.submit(researcher,key(),{attemptId:a.id,answers:answer(a.challenge)});
    await f.skills.cycle(evaluator,key(),{});
    assert.equal(await f.db.transaction(tx=>schoolSkillReady(tx,f.botId)),true);
    await f.org.revoke(owner,key(),{kind:'source',targetId:f.evidence.sourceId,reason:'Source withdrawn'});
    assert.equal(await f.db.transaction(tx=>schoolSkillReady(tx,f.botId)),false);
    assert.equal((await f.skills.status(owner)).attempts.find(r=>r.id===a.id)!.outcome,'passed');
  }finally{await f.db.close();}
});

test('skills HTTP boundary defaults off, limits roles and rejects client-authored grades',async()=>{
  const f=await fixture(),app=await createApp(f.cfg,f.db,true);
  try{
    await app.listen(0,'127.0.0.1');const base=await app.getUrl();
    const call=(route:string,role:string,body?:unknown)=>fetch(base+'/v1'+route,{method:body===undefined?'GET':'POST',headers:{
      Authorization:'Bearer '+f.cfg.principals.find(p=>p.role===role)!.token,'Content-Type':'application/json','Idempotency-Key':key()},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    assert.equal((await call('/skills','researcher')).status,403);
    assert.equal((await (await call('/skills','owner')).json() as any).policy.enabled,false);
    assert.equal((await (await call('/skills/claims','researcher',{})).json() as any).status,'disabled');
    assert.equal((await call('/skills/policy','researcher',{})).status,403);
    assert.equal((await call('/skills/cycles','owner',{})).status,403);
    assert.equal((await call('/skills/recoveries','researcher')).status,403);
    assert.equal((await call('/skills/recoveries','evaluator',{})).status,403);
    assert.equal((await call('/skills/recoveries/revocations','researcher',{})).status,403);
    assert.equal((await call('/skills/recoveries','owner',{botId:'bot',extraAttempts:100})).status,400);
    assert.equal((await call('/skills/diagnostics','researcher')).status,403);
    assert.equal((await call('/skills/versions','researcher')).status,403);
    assert.equal((await call('/skills/remediation/cycles','owner',{})).status,403);
    assert.equal((await call('/skills/diagnostics','owner')).status,200);
    assert.equal((await call('/skills/versions','owner')).status,200);
    assert.equal((await call('/skills/submissions','researcher',{attemptId:randomUUID(),answers:{},passed:true})).status,400);
  }finally{await app.close();await f.db.close();}
});

const producerA={name:'solver',version:'1',sourceSha256:'a'.repeat(64),kind:'deterministic' as const};
const producerB={...producerA,version:'2',sourceSha256:'b'.repeat(64)};
test('exam attribution is fixed before questions, immutable and never inferred for legacy work',async()=>{
  const f=await setup(),diagnostics=new SkillDiagnostics(f.db);
  try{
    const a=(await f.skills.claim(researcher,key(),{producer:producerA})).attempt!;
    assert.equal(a.producerHash,digest(producerA));
    await assert.rejects(()=>f.skills.claim(researcher,key(),{producer:producerB}),/different producer/);
    await assert.rejects(()=>f.skills.submit(researcher,key(),{attemptId:a.id,answers:answer(a.challenge)}),/producer differs/);
    await f.skills.submit(researcher,key(),{attemptId:a.id,producerHash:a.producerHash!,answers:{...answer(a.challenge),netProfitPaise:999999}});
    await f.skills.cycle(evaluator,key(),{});
    const legacy=await f.claim();assert.equal(legacy.producerHash,null);
    await f.skills.submit(researcher,key(),{attemptId:legacy.id,answers:answer(legacy.challenge)});await f.skills.cycle(evaluator,key(),{});
    const versions=await diagnostics.versions(owner);
    assert.equal(versions.producers.length,1);assert.ok(versions.outcomes.some(r=>r.producer_hash===null&&r.passed===1));
    assert.ok(versions.outcomes.some(r=>r.producer_hash===a.producerHash&&r.failed===1));
    await assert.rejects(()=>f.db.transaction(tx=>tx.query('DELETE FROM skill_attempt_producers')));
  }finally{await f.db.close();}
});

test('observed failures create deduplicated diagnoses and independently reviewed corrective lessons without recovery authority',async()=>{
  const f=await setup(),diagnostics=new SkillDiagnostics(f.db);
  try{
    const failedAttemptId=await exhausted(f);
    let status=await diagnostics.status(owner);assert.equal(status.cases.length,3);
    assert.deepEqual(status.cases.find(c=>c.attempt_id===failedAttemptId)!.failed_checks,['costs']);
    assert.equal(status.recurring.find(c=>c.check_name==='costs')!.failures,3);
    const proposed=await diagnostics.cycle(researcher,key(),{});assert.equal(proposed.actions.length,3);
    assert.equal((await diagnostics.cycle(researcher,key(),{})).actions.length,0);
    assert.equal((await diagnostics.cycle({...evaluator,id:researcher.id},key(),{})).actions.length,0);
    assert.equal((await diagnostics.cycle(evaluator,key(),{})).actions.length,3);
    assert.equal((await diagnostics.cycle(evaluator,key(),{})).actions.length,0);
    status=await diagnostics.status(owner);
    const proposal=status.proposals.find(p=>p.attempt_id===failedAttemptId)!;
    assert.equal(proposal.decision,'verified');assert.ok(proposal.lesson_id);
    assert.ok(proposal.content.includes('fees and slippage'));assert.ok(!proposal.content.includes('Track each preceding equity peak'));
    assert.equal((await new SkillRecovery(f.db).status(owner)).items.length,0);
    assert.equal((await f.skills.claim(researcher,key(),{})).attempt,null);
    const grant=await new SkillRecovery(f.db).approve(owner,key(),{botId:f.botId,failedAttemptId,lessonId:proposal.lesson_id,expectedPolicyRevision:1,reason:'Review deterministic corrective lesson and permit one new exam'});
    assert.equal(grant.extraAttempts,1);
    assert.equal((await f.life.community(owner))[0]!.reputation,0);
    await assert.rejects(()=>f.db.transaction(tx=>tx.query('DELETE FROM skill_diagnoses')));
    await assert.rejects(()=>f.db.transaction(tx=>tx.query('DELETE FROM skill_remediation_reviews')));
  }finally{await f.db.close();}
});

test('halt and revoked evidence stop remediation while retaining diagnosis and rejected proposal history',async()=>{
  const f=await setup(),diagnostics=new SkillDiagnostics(f.db);
  try{
    await exhausted(f);
    await f.db.transaction(tx=>tx.query('UPDATE system_lock SET halted=true WHERE id=1'));
    assert.equal((await diagnostics.cycle(researcher,key(),{})).status,'halted');
    await f.db.transaction(tx=>tx.query('UPDATE system_lock SET halted=false WHERE id=1'));
    await diagnostics.cycle(researcher,key(),{});
    await f.org.revoke(owner,key(),{kind:'evidence',targetId:f.evidence.evidenceId,reason:'Withdraw unsupported curriculum'});
    const reviewed=await diagnostics.cycle(evaluator,key(),{});assert.ok(reviewed.actions.every(a=>a.action==='rejected'&&a.lessonId===null));
    const status=await diagnostics.status(owner);assert.equal(status.cases.length,3);assert.equal(status.proposals.length,3);
    assert.equal((await f.org.knowledge(owner)).lessons.length,0);
  }finally{await f.db.close();}
});

test('version comparison includes failures and unreviewed work and never approves an upgrade',async()=>{
  const f=await setup(),diagnostics=new SkillDiagnostics(f.db);
  try{
    for(const producer of [producerA,producerB]){
      const a=(await f.skills.claim(researcher,key(),{producer})).attempt!;
      await f.skills.submit(researcher,key(),{attemptId:a.id,producerHash:a.producerHash!,answers:{...answer(a.challenge),netProfitPaise:999999}});
      await f.skills.cycle(evaluator,key(),{});
    }
    await f.skills.claim(researcher,key(),{producer:producerB});
    const comparison=await diagnostics.compare(owner,{baselineHash:digest(producerA),candidateHash:digest(producerB)});
    assert.equal(comparison.baseline[0]!.attempts,1);assert.equal(comparison.baseline[0]!.failed,1);
    assert.equal(comparison.candidate[0]!.attempts,2);assert.equal(comparison.candidate[0]!.failed,1);assert.equal(comparison.candidate[0]!.outstanding,1);
    assert.equal(comparison.promotionAllowed,false);assert.equal(comparison.verdict,'descriptive-only');
    assert.throws(()=>diagnostics.compare(researcher,{baselineHash:digest(producerA),candidateHash:digest(producerB)}),/not permitted/);
  }finally{await f.db.close();}
});

async function exhausted(f:Awaited<ReturnType<typeof setup>>) {
  let last='';
  for(let i=0;i<3;i++){
    const a=await f.claim();last=a.id;
    await f.skills.submit(researcher,key(),{attemptId:a.id,answers:{...answer(a.challenge),netProfitPaise:999999}});
    assert.equal((await f.skills.cycle(evaluator,key(),{})).actions[0]!.outcome,'failed');
  }
  return last;
}
async function correction(f:Awaited<ReturnType<typeof setup>>,reviewer=evaluator,evidenceId=f.evidence.evidenceId) {
  const lesson=await f.org.lesson(researcher,key(),{botId:f.botId,evidenceId,
    content:'Corrective plan: deduct fees and slippage from gross profit before reporting net performance. Verify with independent examples.'});
  await f.org.verifyLesson(reviewer,key(),{lessonId:lesson.id});return lesson.id as string;
}

test('owner-reviewed recovery grants one real extra exam without resetting history, quotas or authority',async()=>{
  const f=await setup(),recovery=new SkillRecovery(f.db);let app;
  try{
    const failedAttemptId=await exhausted(f);
    assert.ok((await new OrganisationReport(f.db).snapshot(owner)).students[0]!.reasons.some(r=>r.code==='SKILL_ATTEMPTS_EXHAUSTED'));
    const lessonId=await correction(f),body={botId:f.botId,failedAttemptId,lessonId,expectedPolicyRevision:1,reason:'Independent corrective lesson reviewed; approve one bounded reassessment'};
    assert.throws(()=>recovery.approve(evaluator,key(),body),/not permitted/);
    // Exercise actual HTTP/DI registration and idempotency, not only service calls.
    app=await createApp(f.cfg,f.db,true);await app.listen(0,'127.0.0.1');const base=await app.getUrl(),approvalKey=key();
    const approve=()=>fetch(base+'/v1/skills/recoveries',{method:'POST',headers:{Authorization:'Bearer '+f.cfg.principals.find(p=>p.role==='owner')!.token,
      'Content-Type':'application/json','Idempotency-Key':approvalKey},body:JSON.stringify(body)});
    const response=await approve();assert.equal(response.status,201);const grant=await response.json() as any;
    assert.deepEqual(await (await approve()).json(),grant);
    await assert.rejects(()=>recovery.approve(owner,key(),body),/One recovery/);
    const budget=await f.db.transaction(tx=>schoolSkillBudget(tx,f.botId,1));assert.equal(budget.attemptsUsed,3);assert.equal(budget.recoveryAvailable,true);
    const [one,two]=await Promise.all([f.skills.claim(researcher,key(),{}),f.skills.claim(researcher,key(),{})]);
    assert.ok(one.attempt);assert.equal(one.attempt.id,two.attempt!.id);
    assert.equal((await recovery.status(owner)).items[0]!.attempt_id,one.attempt.id);
    const stillPending=(await new OrganisationReport(f.db).snapshot(owner)).students[0]!;
    assert.equal(stillPending.skillBudget!.awaitingOutcome,true);
    assert.equal(stillPending.reasons.some(r=>r.code==='SKILL_ATTEMPTS_EXHAUSTED'),false);
    await f.skills.submit(researcher,key(),{attemptId:one.attempt.id,answers:answer(one.attempt.challenge)});
    assert.equal((await f.skills.cycle(evaluator,key(),{})).actions[0]!.outcome,'passed');
    assert.equal((await f.skills.status(owner)).attempts.length,4);
    assert.equal((await f.skills.status(owner)).attempts.filter(a=>a.outcome==='failed').length,3);
    assert.equal((await f.skills.claim(researcher,key(),{})).attempt,null);
    await f.tick();assert.equal((await f.life.community(owner))[0]!.state,'college');
    assert.equal((await f.life.community(owner))[0]!.reputation,0);
    assert.equal((await f.treasury.snapshot(owner)).wallet1Paise,'0');
    assert.equal((await f.db.transaction(tx=>tx.query('SELECT count(*)::int AS count FROM journals'))).rows[0]!.count,0);
    await assert.rejects(()=>f.db.transaction(tx=>tx.query('DELETE FROM skill_recoveries')));
    await assert.rejects(()=>f.db.transaction(tx=>tx.query('DELETE FROM skill_recovery_attempts')));
  }finally{await app?.close();await f.db.close();}
});

test('recovery refuses old or self-reviewed correction and respects halt, policy revision and global quotas',async()=>{
  const f=await setup(),recovery=new SkillRecovery(f.db);
  try{
    await f.skills.configure(owner,key(),{expectedRevision:1,enabled:true,maxPerDay:3,maxLifetime:3});
    const oldLesson=await correction(f),failedAttemptId=await exhausted(f);
    const body={botId:f.botId,failedAttemptId,lessonId:oldLesson,expectedPolicyRevision:2,reason:'Review recovery'};
    await assert.rejects(()=>recovery.approve(owner,key(),body),/follow the latest failure/);
    const selfReviewed=await correction(f,owner);
    await assert.rejects(()=>recovery.approve(owner,key(),{...body,lessonId:selfReviewed}),/independent reviewer/);
    const lessonId=await correction(f);
    await assert.rejects(()=>recovery.approve(owner,key(),{...body,lessonId,expectedPolicyRevision:0}),/Current enabled/);
    await f.db.transaction(tx=>tx.query('UPDATE system_lock SET halted=true WHERE id=1'));
    await assert.rejects(()=>recovery.approve(owner,key(),{...body,lessonId}),/halted/);
    await f.db.transaction(tx=>tx.query('UPDATE system_lock SET halted=false WHERE id=1'));
    await recovery.approve(owner,key(),{...body,lessonId});
    assert.equal((await f.skills.claim(researcher,key(),{})).status,'capacity');
    assert.equal((await recovery.status(owner)).items[0]!.attempt_id,null);
    await f.skills.configure(owner,key(),{expectedRevision:2,enabled:true,maxPerDay:12,maxLifetime:100});
    assert.equal((await f.skills.claim(researcher,key(),{})).attempt,null);
    await assert.rejects(()=>recovery.approve(owner,key(),{...body,lessonId,expectedPolicyRevision:3}),/One recovery/);
  }finally{await f.db.close();}
});

test('revoking a consumed recovery blocks submission and cannot free another attempt',async()=>{
  const f=await setup(),recovery=new SkillRecovery(f.db);
  try{
    const failedAttemptId=await exhausted(f),lessonId=await correction(f);
    const grant=await recovery.approve(owner,key(),{botId:f.botId,failedAttemptId,lessonId,expectedPolicyRevision:1,reason:'Reassessment'});
    const a=await f.claim();await recovery.revoke(owner,key(),{recoveryId:grant.id,reason:'Correction approval withdrawn'});
    await assert.rejects(()=>f.skills.submit(researcher,key(),{attemptId:a.id,answers:answer(a.challenge)}),/support or policy changed/);
    assert.equal((await f.skills.claim(researcher,key(),{})).attempt,null);
    assert.equal((await f.skills.status(owner)).attempts.length,4);
    await assert.rejects(()=>f.db.transaction(tx=>tx.query('DELETE FROM skill_recovery_revocations')));
  }finally{await f.db.close();}
});

test('lesson changes invalidate a pending recovery review and withdrawal of a passed recovery blocks admission',async()=>{
  for(const afterPass of [false,true]){
    const f=await setup(),recovery=new SkillRecovery(f.db);
    try{
      const failedAttemptId=await exhausted(f),lessonId=await correction(f);
      const grant=await recovery.approve(owner,key(),{botId:f.botId,failedAttemptId,lessonId,expectedPolicyRevision:1,reason:'Reassessment'});
      const a=await f.claim();await f.skills.submit(researcher,key(),{attemptId:a.id,answers:answer(a.challenge)});
      if(afterPass){
        assert.equal((await f.skills.cycle(evaluator,key(),{})).actions[0]!.outcome,'passed');
        assert.equal(await f.db.transaction(tx=>schoolSkillReady(tx,f.botId)),true);
        await recovery.revoke(owner,key(),{recoveryId:grant.id,reason:'Pass support withdrawn'});
      }else{
        // The general lesson API permits re-review. A different reviewer must not silently change a bound recovery.
        await f.org.verifyLesson(owner,key(),{lessonId});
        assert.equal((await f.skills.cycle(evaluator,key(),{})).actions[0]!.outcome,'invalidated');
      }
      assert.equal(await f.db.transaction(tx=>schoolSkillReady(tx,f.botId)),false);
      await f.tick();assert.equal((await f.life.community(owner))[0]!.state,'school');
      assert.equal((await f.skills.status(owner)).attempts.length,4);
    }finally{await f.db.close();}
  }
});

test('expired recovery approvals remain consumed governance history and cannot be used',async()=>{
  const f=await setup();
  try{
    const failedAttemptId=await exhausted(f),lessonId=await correction(f),grantId=randomUUID();
    // Insert an already-expired immutable historical fixture; never alter protected rows or clocks.
    await f.db.transaction(async tx=>{
      const lesson=(await tx.query('SELECT * FROM lessons WHERE id=$1',[lessonId])).rows[0]!;
      const fingerprint=digest({content:lesson.content,author:lesson.author,reviewer:lesson.reviewer,evidenceId:lesson.evidence_id});
      await tx.query(`INSERT INTO skill_recoveries(id,bot_id,failed_attempt_id,lesson_id,lesson_fingerprint,policy_revision,reason,owner_actor,created_at,expires_at)
        VALUES($1,$2,$3,$4,$5,1,'Historical expired approval','owner',clock_timestamp()-interval '8 days',clock_timestamp()-interval '1 day')`,[grantId,f.botId,failedAttemptId,lessonId,fingerprint]);
      await tx.query('INSERT INTO bot_curriculum VALUES($1,$2)',[f.botId,lessonId]);
    });
    assert.equal(await f.db.transaction(tx=>currentSkillRecovery(tx,f.botId,1)),undefined);
    assert.equal((await f.skills.claim(researcher,key(),{})).attempt,null);
    assert.equal((await new SkillRecovery(f.db).status(owner)).items[0]!.expired,true);
  }finally{await f.db.close();}
});
