import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ResearchLifecycle } from '../src/lifecycle.js';
import { PortfolioResearch } from '../src/portfolio.js';
import { ResearchDispatch } from '../src/dispatch.js';
import { fixture,owner,researcher,evaluator,key } from './helpers.js';

async function setup(){
  const f=await fixture(),life=new ResearchLifecycle(f.db),portfolio=new PortfolioResearch(f.db);
  try{
    const evidence=await f.evidence();
    await f.org.bot(owner,key(),{id:'teacher',name:'Curriculum author',department:'education',specialty:'research-basics',method:'lessons',contribution:'Retain lessons for future students',budgetPaise:'0'});
    const lesson=await f.org.lesson(researcher,key(),{botId:'teacher',content:'Past-only fitting and honest negative results',evidenceId:evidence.evidenceId});
    await f.org.verifyLesson(evaluator,key(),{lessonId:lesson.id});
    const blueprint={id:'allocation-student',name:'Allocation student',specialty:'diversification',method:'minimum_variance',contribution:'Evaluate a distinct constrained allocation speciality',evidenceId:evidence.evidenceId,lessonIds:[lesson.id],mentorId:'teacher'};
    await life.blueprint(owner,key(),blueprint);
    const initial=(await life.status(owner)).policy!;
    const enable=()=>life.configure(owner,key(),{expectedRevision:initial.revision,rules:{...initial.rules,enabled:true}});
    const tick=async()=>{
      await f.db.transaction(tx=>tx.query("UPDATE lifecycle_policy SET last_cycle_at=now()-interval '2 hours' WHERE id=1"));
      return life.cycle(evaluator,key(),{});
    };
    const birth=async()=>{
      await enable();const cycle=await tick();
      const born=cycle.actions.find(a=>(a as any).action==='born') as {botId:string};
      assert.ok(born);await tick();return born.botId;
    };
    return {...f,createEvidence:f.evidence,life,portfolio,evidence,lesson,blueprint,initial,enable,tick,birth};
  }catch(error){await f.db.close();throw error;}
}

type Fixture=Awaited<ReturnType<typeof setup>>;
async function assignmentFor(f:Fixture,botId:string,datasetId:string){
  const dispatch=new ResearchDispatch(f.db),policy=(await dispatch.status(owner)).policy!;
  const datasetIds=[datasetId];
  await dispatch.configure(owner,key(),{expectedRevision:policy.revision,rules:{...policy.rules,enabled:true,datasetIds,maxAssignmentsPerDay:100}});
  await dispatch.cycle(evaluator,key(),{});
  const claimed=(await dispatch.claim(researcher,key(),{})).assignment!;
  assert.equal(claimed.botId,botId);assert.equal(claimed.datasetId,datasetId);
  return {id:claimed.id,leaseToken:claimed.leaseToken};
}
async function trial(f:Fixture,botId:string,index:number,positive=false,evidenceId=f.evidence.evidenceId){
  const rows=(count:number,offset:number,heldout=false)=>Array.from({length:count},(_,i)=>({timestamp:new Date(Date.UTC(2020,0,1+offset+i)).toISOString(),
    returns:Array.from({length:8},(_,asset)=>heldout ? (asset<4 ? (positive ? 0.005 : -0.005) : (positive ? -0.005 : 0.005)) : 0.001)}));
  const dataset=await f.portfolio.dataset(owner,key(),{evidenceId,purpose:'example-testing',assets:['A','B','C','D','E','F','G','H'],training:rows(60,0),holdout:rows(20,100+30*index,true)});
  const assignment=await assignmentFor(f,botId,dataset.id);
  const submitted=await f.portfolio.submit(researcher,key(),{botId,datasetId:dataset.id,datasetDigest:dataset.digest,method:'minimum_variance',weights:[.25,.25,.25,.25,0,0,0,0],assignment});
  await f.portfolio.review(evaluator,key(),{trialId:submitted.id});return dataset;
}

test('lifecycle defaults off; only owner controls approved capabilities and policy',async()=>{
  const f=await setup();
  try{
    assert.equal((await f.life.cycle(evaluator,key(),{})).status,'disabled');
    assert.equal((await f.life.community(owner)).length,0);
    assert.throws(()=>f.life.configure(researcher,key(),{expectedRevision:0,rules:f.initial.rules}),/not permitted/);
    assert.throws(()=>f.life.blueprint(evaluator,key(),f.blueprint),/not permitted/);
    assert.throws(()=>f.life.cycle(researcher,key(),{}),/not permitted/);
    await assert.rejects(()=>f.life.blueprint(owner,key(),{...f.blueprint,id:'renamed'}),/capability already exists/);
    await f.enable();
    await assert.rejects(()=>f.life.configure(owner,key(),{expectedRevision:0,rules:f.initial.rules}),/revision changed/);
    await f.db.transaction(tx=>tx.query('UPDATE system_lock SET halted=true WHERE id=1'));
    assert.equal((await f.tick()).status,'halted');
  }finally{await f.db.close();}
});

test('birth inherits reviewed lessons and cannot grant money, credentials or paper status',async()=>{
  const f=await setup();
  try{
    const student=await f.birth();
    const bot=(await f.org.list(owner)).find(b=>b.id===student)!;
    assert.equal(bot.state,'college');assert.equal(bot.lifecycle_managed,true);assert.equal(bot.mentor_id,'teacher');
    assert.equal((await f.life.community(owner)).length,1);
    assert.equal((await f.life.cycle(evaluator,key(),{})).status,'cooldown');
    const curriculum=await f.db.transaction(tx=>tx.query('SELECT lesson_id FROM bot_curriculum WHERE bot_id=$1',[student]));
    assert.equal(curriculum.rows[0]!.lesson_id,f.lesson.id);
    await assert.rejects(()=>f.db.transaction(tx=>tx.query("UPDATE bots SET state='paper' WHERE id=$1",[student])),/managed_bots_are_research_only/);
    await assert.rejects(()=>f.db.transaction(tx=>tx.query('UPDATE bots SET budget_paise=1 WHERE id=$1',[student])),/managed_bots_are_research_only/);
    await assert.rejects(()=>f.research.experiment(researcher,key(),{botId:student,datasetId:randomUUID(),hypothesis:'Bypass through momentum'}),/example-only/);
    assert.equal((await f.treasury.snapshot(owner)).wallet1Paise,'0');
    const commandKey=key();const cycle=await f.life.cycle(evaluator,commandKey,{});
    assert.deepEqual(await f.life.cycle(evaluator,commandKey,{}),cycle);
  }finally{await f.db.close();}
});

test('population and rolling-day caps prevent an approved queue from growing without limits',async()=>{
  const f=await setup();
  try{
    await f.life.blueprint(owner,key(),{...f.blueprint,id:'other-student',specialty:'other-allocation'});
    await f.life.configure(owner,key(),{expectedRevision:0,rules:{...f.initial.rules,enabled:true,maxActiveBots:1,maxBirthsPerDay:1,maxLifetimeBots:2}});
    await f.tick();await f.tick();await f.tick();
    assert.equal((await f.life.community(owner)).length,1);
    const current=(await f.life.status(owner)).policy!;
    await f.life.configure(owner,key(),{expectedRevision:current.revision,rules:{...current.rules,maxActiveBots:2}});
    await f.tick();assert.equal((await f.life.community(owner)).length,1);
    await f.db.transaction(tx=>tx.query("UPDATE bot_lifecycle SET born_at=now()-interval '25 hours'"));
    await f.tick();assert.equal((await f.life.community(owner)).length,2);
    assert.equal((await f.life.status(owner)).blueprints.filter(b=>b.state==='used').length,2);
  }finally{await f.db.close();}
});

test('negative fitness needs distinct evidence; repeated polling cannot punish twice; retirement preserves knowledge',async()=>{
  const f=await setup();
  try{
    const student=await f.birth();
    for(let batch=0;batch<3;batch++){
      for(let i=0;i<3;i++)await trial(f,student,batch*3+i);
      await f.tick();
      const before=(await f.life.status(owner)).reviews.length;
      await f.tick();assert.equal((await f.life.status(owner)).reviews.length,before);
      if(batch<2)assert.equal((await f.org.list(owner)).find(b=>b.id===student)!.state,'college');
    }
    assert.equal((await f.org.list(owner)).find(b=>b.id===student)!.state,'retired');
    const archive=(await f.life.archives(owner))[0]!;
    assert.equal(archive.bot_id,student);assert.equal(archive.knowledge.trials.length,9);
    assert.equal(archive.knowledge.reviews.length,3);assert.equal(archive.knowledge.lessons[0].id,f.lesson.id);
    assert.ok((await f.org.knowledge(researcher)).lessons.some(l=>l.id===f.lesson.id));
    assert.equal((await f.org.list(owner)).find(b=>b.id==='teacher')!.state,'school');
    assert.equal((await f.ops.verifyAudit(owner)).valid,true);
  }finally{await f.db.close();}
});

test('positive research rewards can yield mentorship without trading graduation',async()=>{
  const f=await setup();
  try{
    const student=await f.birth();
    for(let batch=0;batch<3;batch++){
      for(let i=0;i<3;i++)await trial(f,student,batch*3+i,true);
      await f.tick();
    }
    const member=(await f.life.community(researcher))[0]!;
    assert.equal(member.designation,'mentor');assert.equal(member.reputation,30);assert.equal(member.state,'college');
    assert.throws(()=>f.life.archives(researcher),/not permitted/);
  }finally{await f.db.close();}
});

test('revoked evidence breaks a negative streak and cannot count towards retirement',async()=>{
  const f=await setup();
  try{
    const student=await f.birth();
    const revocable=await f.createEvidence();
    for(let i=0;i<3;i++)await trial(f,student,i);
    await f.tick();
    for(let i=3;i<6;i++)await trial(f,student,i,false,revocable.evidenceId);
    await f.tick();
    await f.org.revoke(owner,key(),{kind:'evidence',targetId:revocable.evidenceId,reason:'Evidence withdrawn'});
    for(let i=6;i<9;i++)await trial(f,student,i);
    await f.tick();
    const member=(await f.life.status(owner)).students[0]!;
    assert.equal(member.negative_streak,1);assert.equal(member.state,'college');
    assert.equal((await f.life.archives(owner)).length,0);
  }finally{await f.db.close();}
});

test('retirement drains pending work; owner cancellation allows archive on next cycle',async()=>{
  const f=await setup();
  try{
    const student=await f.birth();let dataset:any;
    for(let batch=0;batch<3;batch++){
      for(let i=0;i<3;i++)dataset=await trial(f,student,batch*3+i);
      if(batch<2)await f.tick();
    }
    const held=await f.portfolio.dataset(owner,key(),{evidenceId:f.evidence.evidenceId,purpose:'example-testing',assets:['A','B','C','D'],
      training:Array.from({length:60},(_,i)=>({timestamp:new Date(Date.UTC(2021,0,1+i)).toISOString(),returns:[.001,.001,.001,.001]})),
      holdout:Array.from({length:20},(_,i)=>({timestamp:new Date(Date.UTC(2021,4,1+i)).toISOString(),returns:[.001,.001,.001,.001]}))});
    const assignment=await assignmentFor(f,student,held.id);
    const pending=await f.portfolio.submit(researcher,key(),{botId:student,datasetId:held.id,datasetDigest:held.digest,method:'minimum_variance',weights:[.25,.25,.25,.25],assignment});
    await f.tick();assert.equal((await f.life.status(owner)).students[0]!.retirement_pending,true);
    await assert.rejects(()=>f.portfolio.submit(researcher,key(),{botId:student,datasetId:dataset.id,datasetDigest:dataset.digest,method:'minimum_variance',weights:[.25,.25,.25,.25,0,0,0,0]}),/closing work/);
    await f.portfolio.cancel(owner,key(),{trialId:pending.id,reason:'Finish retirement drain'});
    await f.tick();assert.equal((await f.org.list(owner)).find(b=>b.id===student)!.state,'retired');
  }finally{await f.db.close();}
});
