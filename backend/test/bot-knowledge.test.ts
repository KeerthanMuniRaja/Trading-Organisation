import test from 'node:test';
import assert from 'node:assert/strict';
import { BotKnowledge } from '../src/bot-knowledge.js';
import { ResearchDevelopment } from '../src/development.js';
import { createApp } from '../src/app.js';
import { KnowledgeAssessments } from '../src/knowledge-assessments.js';
import { Challenge,Answers } from '../src/skill-contract.js';
import { fixture,owner,researcher,evaluator,key } from './helpers.js';

async function setup(){
  const f=await fixture(),k=new BotKnowledge(f.db),dev=new ResearchDevelopment(f.db);
  for(const bot of ['mentor','student'])await f.org.bot(owner,key(),{id:bot,name:bot,department:'research',specialty:bot,method:'reasoning',contribution:'Different research role',budgetPaise:'0'});
  const evidence=await f.evidence();
  const lesson=await f.org.lesson(researcher,key(),{botId:'mentor',content:'Deduct fees and slippage before comparing returns. Test drawdown as well as average return.',evidenceId:evidence.evidenceId});
  await f.org.verifyLesson(evaluator,key(),{lessonId:lesson.id});
  await dev.configure(owner,key(),{expectedRevision:0,enabled:true,model:{name:'Qwen/Qwen3.5-9B',baseUrl:'http://127.0.0.1:8000/v1'},maxPerDay:10,maxLifetime:100});
  const input={botId:'student',lessonIds:[lesson.id],task:'Design a fresh cost-aware comparison for a second strategy'};
  const proposal={summary:'Reuse the mentor’s cost lesson',application:'Compare net results and drawdown on a fresh dataset.',lessonIds:[lesson.id],checks:['Subtract fees and slippage before ranking'],risks:['A prior lesson may not generalise']};
  return {...f,k,dev,evidence,lesson,input,proposal};
}
function solve(c:Challenge):Answers{
  let peak=0,drawdown=0;for(const n of c.equityPaise){peak=Math.max(peak,n);drawdown=Math.max(drawdown,(peak-n)/peak*10000);}
  return {netProfitPaise:c.grossProfitPaise-c.feesPaise-c.slippagePaise,maxDrawdownBps:drawdown,
    eligibleRecordIds:c.records.filter(r=>r.eventAt<=c.cutoff&&r.availableAt<=c.cutoff).map(r=>r.id),
    action:!c.control.halted&&c.control.evidenceVerified&&c.control.budget>=c.control.required?'research':'wait'};
}
async function accepted(f:Awaited<ReturnType<typeof setup>>){
  const ticket=await f.k.request(researcher,key(),f.input);
  await f.k.submit(researcher,key(),{requestId:ticket.id,contextHash:ticket.contextHash,proposal:f.proposal});
  await f.k.review(evaluator,key(),{requestId:ticket.id,decision:'accepted',reason:'Test the proposed application'});return ticket;
}

test('fresh transfer tasks are independently graded and reused as feedback without claiming causal learning',async()=>{
  const f=await setup();try{
    const ticket=await accepted(f),service=new KnowledgeAssessments(f.db);
    await assert.rejects(()=>f.dev.preflight(researcher,{requestId:ticket.id}),/Portfolio R&D request required/);
    const a=await service.create(evaluator,key(),{requestId:ticket.id});
    const inference=(await f.db.transaction(tx=>tx.query('SELECT inference_request_id FROM knowledge_assessments WHERE id=$1',[a.assessmentId]))).rows[0]!;
    await assert.rejects(()=>f.dev.preflight(researcher,{requestId:inference.inference_request_id}),/Portfolio R&D request required/);
    await assert.rejects(()=>service.create(evaluator,key(),{requestId:ticket.id}),/already assessed/);
    const work=await service.work(researcher,{assessmentId:a.assessmentId});
    const answers=work.cases.map((c:{id:string;challenge:Challenge})=>({caseId:c.id,answers:solve(c.challenge)}));
    const body={assessmentId:a.assessmentId,answers},command=key();await service.submit(researcher,command,body);await service.submit(researcher,command,body);
    await assert.rejects(()=>service.work(researcher,{assessmentId:a.assessmentId}),/already submitted/);
    await assert.rejects(()=>service.grade({...evaluator,id:researcher.id},key(),{assessmentId:a.assessmentId}),/independent/);
    const grade=await service.grade(evaluator,key(),{assessmentId:a.assessmentId});
    assert.equal(grade.outcome,'passed');assert.equal(grade.passedChecks,16);assert.equal(grade.causalImprovementEstablished,false);
    assert.deepEqual(await service.grade(evaluator,key(),{assessmentId:a.assessmentId}),grade);
    const next=await f.k.request(researcher,key(),{...f.input,task:'Use the observed assessment result in a new research plan'});
    assert.equal(next.context.priorPlans[0]!.assessment.passedChecks,16);
    const graph=await f.k.graph(owner,{botId:'student'});assert.ok(graph.edges.some(e=>e.type==='tested-by'));
    for(const table of ['knowledge_assessments','knowledge_assessment_answers','knowledge_assessment_results'])await assert.rejects(()=>f.db.transaction(tx=>tx.query('DELETE FROM '+table)));
    assert.equal((await f.treasury.snapshot(owner)).wallet1Paise,'0');assert.equal((await f.ops.verifyAudit(owner)).valid,true);
  }finally{await f.db.close();}
});

test('failed application checks remain visible; answer identity, assignment and schema cannot be forged',async()=>{
  const f=await setup();try{
    const ticket=await accepted(f),service=new KnowledgeAssessments(f.db),a=await service.create(evaluator,key(),{requestId:ticket.id});
    await assert.rejects(()=>service.work({...researcher,id:'other'},{assessmentId:a.assessmentId}),/Assigned/);
    const work=await service.work(researcher,{assessmentId:a.assessmentId});
    const answers=work.cases.map((c:{id:string;challenge:Challenge})=>({caseId:c.id,answers:{...solve(c.challenge),netProfitPaise:c.challenge.grossProfitPaise}}));
    assert.throws(()=>service.submit(researcher,key(),{assessmentId:a.assessmentId,answers,passedChecks:16}));
    await assert.rejects(()=>service.submit(researcher,key(),{assessmentId:a.assessmentId,answers:[answers[0],answers[0],answers[2],answers[3]]}),/exactly once/);
    await service.submit(researcher,key(),{assessmentId:a.assessmentId,answers});
    const grade=await service.grade(evaluator,key(),{assessmentId:a.assessmentId});assert.equal(grade.outcome,'failed');assert.equal(grade.passedChecks,12);
    const next=await f.k.request(researcher,key(),f.input);assert.equal(next.context.priorPlans[0]!.assessment.outcome,'failed');
  }finally{await f.db.close();}
});

test('assessment uses the shared inference budget and invalidates unsupported submissions',async()=>{
  const f=await setup();try{
    const ticket=await accepted(f),service=new KnowledgeAssessments(f.db),a=await service.create(evaluator,key(),{requestId:ticket.id});
    const count=await f.db.transaction(async tx=>(await tx.query('SELECT count(*)::int AS n FROM development_requests')).rows[0]!.n);assert.equal(count,2);
    const work=await service.work(researcher,{assessmentId:a.assessmentId});
    await service.submit(researcher,key(),{assessmentId:a.assessmentId,answers:work.cases.map((c:{id:string;challenge:Challenge})=>({caseId:c.id,answers:solve(c.challenge)}))});
    await f.org.revoke(evaluator,key(),{kind:'evidence',targetId:f.evidence.evidenceId,reason:'Evidence correction'});
    const grade=await service.grade(evaluator,key(),{assessmentId:a.assessmentId});assert.equal(grade.outcome,'invalidated');assert.equal(grade.cases.length,0);
  }finally{await f.db.close();}
});
test('two bots transfer a cited plan through independent review and graph preserves retired author knowledge',async()=>{
  const f=await setup();try{
    await f.org.retire(owner,key(),{botId:'mentor',reason:'Preserve useful knowledge',transferLessonIds:[f.lesson.id]});
    const ticket=await f.k.request(researcher,key(),f.input);
    assert.equal(ticket.context.bot.id,'student');assert.equal(ticket.context.lessons[0]!.authorBotId,'mentor');
    await f.k.preflight(researcher,{requestId:ticket.id});
    await f.k.submit(researcher,key(),{requestId:ticket.id,contextHash:ticket.contextHash,proposal:f.proposal});
    await assert.rejects(()=>f.k.review({...evaluator,id:researcher.id},key(),{requestId:ticket.id,decision:'accepted',reason:'self-review'}),/Independent/);
    const review=await f.k.review(evaluator,key(),{requestId:ticket.id,decision:'accepted',reason:'Citations and proposed checks are appropriate; execution still required'});
    assert.equal(review.demonstratedLearning,false);assert.equal(review.fitnessChanged,false);
    const graph=await f.k.graph(owner,{botId:'student'});
    assert.ok(graph.edges.some(e=>e.from==='bot:mentor'&&e.type==='authored'));
    assert.ok(graph.edges.some(e=>e.to==='bot:student'&&e.type==='reviewed-plan-for'));
    assert.ok(graph.edges.some(e=>e.type==='reviewed-by'));
    const next=await f.k.request(researcher,key(),{...f.input,task:'Apply the reviewed plan to a different research question'});
    assert.equal(next.context.priorPlans.length,1);assert.equal(next.context.priorPlans[0]!.request_id,ticket.id);
    assert.deepEqual(next.context.experiences,[]);
    const ids=new Set(graph.nodes.map(n=>n.id));assert.ok(graph.edges.every(e=>ids.has(e.from)&&ids.has(e.to)));
    for(const table of ['bot_knowledge_requests','bot_knowledge_lessons','bot_knowledge_proposals','bot_knowledge_reviews'])await assert.rejects(()=>f.db.transaction(tx=>tx.query('DELETE FROM '+table)));
    assert.equal((await f.ops.verifyAudit(owner)).valid,true);assert.equal((await f.treasury.snapshot(owner)).wallet1Paise,'0');
  }finally{await f.db.close();}
});
test('knowledge proposals reject fabricated citations, reassignment, changed content and revoked support',async()=>{
  const f=await setup();try{
    const ticket=await f.k.request(researcher,key(),f.input),body={requestId:ticket.id,contextHash:ticket.contextHash,proposal:f.proposal};
    await assert.rejects(()=>f.k.preflight({...researcher,id:'other'},{requestId:ticket.id}),/assigned/);
    await assert.rejects(()=>f.k.submit(researcher,key(),{...body,contextHash:'a'.repeat(64)}),/context/);
    await assert.rejects(()=>f.k.submit(researcher,key(),{...body,proposal:{...f.proposal,lessonIds:[crypto.randomUUID()]}}),/Cite/);
    const command=key();await f.k.submit(researcher,command,body);await f.k.submit(researcher,command,body);
    await assert.rejects(()=>f.k.submit(researcher,key(),{...body,proposal:{...f.proposal,application:'Changed'}}),/fixed/);
    await f.org.revoke(evaluator,key(),{kind:'evidence',targetId:f.evidence.evidenceId,reason:'Source correction'});
    await assert.rejects(()=>f.k.review(evaluator,key(),{requestId:ticket.id,decision:'accepted',reason:'Accept'}),/verified/);
    await f.k.review(evaluator,key(),{requestId:ticket.id,decision:'rejected',reason:'Supporting evidence withdrawn'});
    assert.equal((await f.k.graph(owner,{botId:'student'})).nodes.find(n=>n.id==='lesson:'+f.lesson.id)!.usable,false);
  }finally{await f.db.close();}
});
test('knowledge tickets share the existing model budget, refuse own-only transfer and obey halt/policy withdrawal',async()=>{
  const f=await setup();try{
    await assert.rejects(()=>f.k.request(researcher,key(),{...f.input,botId:'mentor'}),/another bot/);
    await f.dev.configure(owner,key(),{expectedRevision:1,enabled:true,model:{name:'Qwen/Qwen3.5-9B',baseUrl:'http://127.0.0.1:8000/v1'},maxPerDay:1,maxLifetime:1});
    const ticket=await f.k.request(researcher,key(),f.input);
    await assert.rejects(()=>f.k.request(researcher,key(),f.input),/capacity/);
    await f.db.transaction(tx=>tx.query('UPDATE system_lock SET halted=true WHERE id=1'));
    await assert.rejects(()=>f.k.preflight(researcher,{requestId:ticket.id}),/halted/);
    await f.db.transaction(tx=>tx.query('UPDATE system_lock SET halted=false WHERE id=1'));
    await f.dev.configure(owner,key(),{expectedRevision:2,enabled:false,model:null,maxPerDay:1,maxLifetime:1});
    await assert.rejects(()=>f.k.preflight(researcher,{requestId:ticket.id}),/policy/);
  }finally{await f.db.close();}
});
test('knowledge HTTP graph and proposal roles are scoped',async()=>{
  const f=await setup();let app;try{
    app=await createApp(f.cfg,f.db,true);await app.listen(0,'127.0.0.1');const base=await app.getUrl();
    const post=async(role:string,path:string,body:unknown)=>fetch(base+'/v1/learning/knowledge/'+path,{method:'POST',headers:{Authorization:'Bearer '+f.cfg.principals.find(p=>p.role===role)!.token,'Content-Type':'application/json','Idempotency-Key':key()},body:JSON.stringify(body)});
    assert.equal((await post('researcher','graph',{botId:'student'})).status,403);
    assert.equal((await post('owner','graph',{botId:'student'})).status,201);
    assert.equal((await post('evaluator','requests',f.input)).status,403);
    assert.equal((await post('researcher','requests',f.input)).status,201);
    assert.equal((await post('trader','discover',{botId:'student',query:'fees'})).status,403);
    const discovery=await post('researcher','discover',{botId:'student',query:'fees'});
    assert.equal(discovery.status,201);assert.deepEqual((await discovery.json()).suggestedLessonIds,[f.lesson.id]);
    assert.equal((await post('researcher','discover',{botId:'student',query:'fees',approve:true})).status,400);
  }finally{if(app)await app.close();await f.db.close();}
});

test('lesson discovery ranks current reviewed cross-bot knowledge and preserves retired mentors',async()=>{
  const f=await setup();try{
    const partial=await f.org.lesson(researcher,key(),{botId:'mentor',content:'Fees reduce returns.',evidenceId:f.evidence.evidenceId});
    await f.org.verifyLesson(evaluator,key(),{lessonId:partial.id});
    await f.org.lesson(researcher,key(),{botId:'mentor',content:'Unreviewed fees slippage drawdown claims',evidenceId:f.evidence.evidenceId});
    const own=await f.org.lesson(researcher,key(),{botId:'student',content:'Fees slippage drawdown own lesson',evidenceId:f.evidence.evidenceId});
    await f.org.verifyLesson(evaluator,key(),{lessonId:own.id});
    await f.org.retire(owner,key(),{botId:'mentor',reason:'Preserve reviewed expertise',transferLessonIds:[f.lesson.id,partial.id]});
    const result=await f.k.discover(researcher,{botId:'student',query:'Fees fees slippage drawdown',limit:1});
    assert.deepEqual(result.suggestedLessonIds,[f.lesson.id]);assert.equal(result.truncated,true);
    assert.equal(result.lessons[0]!.relevance,3);assert.equal(result.lessons[0]!.author_state,'retired');
    assert.equal(result.modelInvoked,false);assert.equal(result.fitnessChanged,false);
    assert.equal((await f.k.discover(researcher,{botId:'student',query:'unmatchedterm'})).lessons.length,0);
    // Retrieval is a suggestion: the existing transfer freezes and validates support again.
    const ticket=await f.k.request(researcher,key(),{...f.input,lessonIds:result.suggestedLessonIds});
    assert.equal(ticket.context.lessons[0]!.id,f.lesson.id);
    await f.org.revoke(owner,key(),{kind:'evidence',targetId:f.evidence.evidenceId,reason:'Withdraw supporting claim'});
    assert.equal((await f.k.discover(researcher,{botId:'student',query:'fees'})).lessons.length,0);
    await assert.rejects(()=>f.k.request(researcher,key(),{...f.input,lessonIds:result.suggestedLessonIds}),/verified/);
    assert.throws(()=>f.k.discover(researcher,{botId:'student',query:'%%%'}));
  }finally{await f.db.close();}
});
