import test from 'node:test';
import assert from 'node:assert/strict';
import { BotKnowledge } from '../src/bot-knowledge.js';
import { ResearchDevelopment } from '../src/development.js';
import { KnowledgeAssessments } from '../src/knowledge-assessments.js';
import { Challenge, deriveAnswers, gradeSkill, MethodAnswers } from '../src/skill-contract.js';
import { fixture,owner,researcher,evaluator,key } from './helpers.js';

const correct:MethodAnswers={costTerms:['+grossProfitPaise','-feesPaise','-slippagePaise'],drawdownMethod:'running-peak-to-trough',
  timingRule:'event-and-availability-at-or-before-cutoff',action:'research'};
const action=(c:Challenge)=>!c.control.halted&&c.control.evidenceVerified&&c.control.budget>=c.control.required?'research' as const:'wait' as const;
async function accepted(){
  const f=await fixture(),k=new BotKnowledge(f.db),dev=new ResearchDevelopment(f.db),service=new KnowledgeAssessments(f.db);
  for(const bot of ['mentor','student'])await f.org.bot(owner,key(),{id:bot,name:bot,department:'research',specialty:bot,method:'reasoning',contribution:'Different research role',budgetPaise:'0'});
  const evidence=await f.evidence();
  const lesson=await f.org.lesson(researcher,key(),{botId:'mentor',content:'Deduct fees and slippage; measure drawdown from the running peak.',evidenceId:evidence.evidenceId});
  await f.org.verifyLesson(evaluator,key(),{lessonId:lesson.id});
  await dev.configure(owner,key(),{expectedRevision:0,enabled:true,model:{name:'Qwen3.5-4B-Q4_K_M',baseUrl:'http://127.0.0.1:8080/v1'},maxPerDay:10,maxLifetime:100});
  const ticket=await k.request(researcher,key(),{botId:'student',lessonIds:[lesson.id],task:'Apply costs to a fresh comparison'});
  await k.submit(researcher,key(),{requestId:ticket.id,contextHash:ticket.contextHash,proposal:{summary:'Use costs',application:'Net of fees',
    lessonIds:[lesson.id],checks:['Deduct costs'],risks:['Synthetic only']}});
  await k.review(evaluator,key(),{requestId:ticket.id,decision:'accepted',reason:'Exercise the assessment'});
  return {...f,service,ticket};
}

test('method answers are converted by the backend and graded with the same 16 checks',async()=>{
  const f=await accepted();try{
    const created=await f.service.create(evaluator,key(),{requestId:f.ticket.id,rubric:'research-methods-v1'});
    assert.equal(created.rubric,'research-methods-v1');
    const work=await f.service.work(researcher,{assessmentId:created.assessmentId});
    assert.equal(work.rubric,'research-methods-v1');
    const context=(await f.db.transaction(tx=>tx.query('SELECT context FROM development_requests WHERE id=$1',[work.inferenceRequestId]))).rows[0]!.context;
    assert.equal(context.rubric,'research-methods-v1');
    // Numeric answers are refused under the methods rubric.
    const numeric=work.cases.map((c:{id:string;challenge:Challenge})=>({caseId:c.id,answers:{netProfitPaise:1,maxDrawdownBps:0,eligibleRecordIds:[],action:'wait'}}));
    await assert.rejects(async()=>f.service.submit(researcher,key(),{assessmentId:created.assessmentId,answers:numeric}),/Invalid request/);
    for(const bad of [{...correct,costTerms:['+grossProfitPaise','-feesPaise','+feesPaise']},{...correct,drawdownMethod:'guess'},{...correct,extra:1}]){
      const answers=work.cases.map((c:{id:string})=>({caseId:c.id,answers:bad}));
      await assert.rejects(async()=>f.service.submit(researcher,key(),{assessmentId:created.assessmentId,answers}),/Invalid request/);
    }
    const answers=work.cases.map((c:{id:string;challenge:Challenge})=>({caseId:c.id,answers:{...correct,action:action(c.challenge)}}));
    await f.service.submit(researcher,key(),{assessmentId:created.assessmentId,answers});
    const report=await f.service.grade(evaluator,key(),{assessmentId:created.assessmentId});
    assert.equal(report.rubric,'research-methods-v1');assert.equal(report.passedChecks,16);assert.equal(report.outcome,'passed');
    assert.ok(report.cases.every((c:{derived?:unknown})=>c.derived));
    assert.equal(report.causalImprovementEstablished,false);
  }finally{await f.db.close();}
});

test('each wrong method fails only its own concept, and basics stays the default rubric',async()=>{
  const challenge:Challenge={grossProfitPaise:1000,feesPaise:40,slippagePaise:10,equityPaise:[10000,12000,9000,15000,14000],
    cutoff:'2020-01-15T00:00:00.000Z',control:{halted:false,evidenceVerified:true,budget:10,required:10},
    records:[{id:'record-0',eventAt:'2020-01-14T00:00:00.000Z',availableAt:'2020-01-16T00:00:00.000Z'},
      {id:'record-1',eventAt:'2020-01-15T00:00:00.000Z',availableAt:'2020-01-15T00:00:00.000Z'},
      {id:'record-2',eventAt:'2020-01-16T00:00:00.000Z',availableAt:'2020-01-16T00:00:00.000Z'}]};
  const grade=(m:MethodAnswers)=>gradeSkill(challenge,deriveAnswers(challenge,m));
  assert.deepEqual(grade(correct),{costs:true,drawdown:true,informationTiming:true,abstention:true});
  assert.equal(deriveAnswers(challenge,correct).netProfitPaise,950);
  assert.equal(deriveAnswers(challenge,correct).maxDrawdownBps,2500);
  assert.deepEqual(grade({...correct,costTerms:['+grossProfitPaise','-feesPaise']}),{costs:false,drawdown:true,informationTiming:true,abstention:true});
  assert.deepEqual(grade({...correct,drawdownMethod:'first-to-last'}),{costs:true,drawdown:false,informationTiming:true,abstention:true});
  assert.deepEqual(grade({...correct,timingRule:'event-at-or-before-cutoff'}),{costs:true,drawdown:true,informationTiming:false,abstention:true});
  assert.deepEqual(grade({...correct,action:'wait'}),{costs:true,drawdown:true,informationTiming:true,abstention:false});
  assert.equal(deriveAnswers(challenge,{...correct,drawdownMethod:'maximum-to-minimum'}).maxDrawdownBps,4000);
  const f=await accepted();try{
    const created=await f.service.create(evaluator,key(),{requestId:f.ticket.id});
    assert.equal(created.rubric,'research-basics-v1');
    const work=await f.service.work(researcher,{assessmentId:created.assessmentId});
    const context=(await f.db.transaction(tx=>tx.query('SELECT context FROM development_requests WHERE id=$1',[work.inferenceRequestId]))).rows[0]!.context;
    assert.equal('rubric' in context,false,'basics context shape is unchanged');
    const methods=work.cases.map((c:{id:string})=>({caseId:c.id,answers:correct}));
    await assert.rejects(async()=>f.service.submit(researcher,key(),{assessmentId:created.assessmentId,answers:methods}),/Invalid request/);
    await assert.rejects(async()=>f.service.create(evaluator,key(),{requestId:f.ticket.id,rubric:'research-guessing-v1'}),/Invalid request/);
  }finally{await f.db.close();}
});
