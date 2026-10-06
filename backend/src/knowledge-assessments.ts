import { z } from 'zod';
import { Actor,digest,parse,permit,requireThat,uuid } from './core.js';
import { audit,Database,Row,Sql } from './database.js';
import { Answers,Challenge,deriveAnswers,gradeSkill,knowledgeRubrics,makeChallenge,methodAnswers,methodsRubric,MethodAnswers,skillAnswers,skillRubric } from './skill-contract.js';
import { assertTokenCapacity } from './inference-usage.js';

const ref=z.object({assessmentId:z.uuid()}).strict();
type Case={id:string;challenge:Challenge};
async function support(tx:Sql,requestId:string){
  const r=(await tx.query(`SELECT d.*,k.bot_id,r.decision,b.state,c.enabled,c.revision,
    (SELECT halted FROM system_lock WHERE id=1) AS halted,
    NOT EXISTS(SELECT 1 FROM bot_knowledge_lessons x JOIN lessons l ON l.id=x.lesson_id
      JOIN evidence e ON e.id=l.evidence_id JOIN sources s ON s.id=e.source_id WHERE x.request_id=d.id
      AND (l.status<>'verified' OR e.status<>'verified' OR NOT s.approved OR e.published_at>now())) AS supported
    FROM development_requests d JOIN bot_knowledge_requests k ON k.request_id=d.id
    JOIN bot_knowledge_reviews r ON r.request_id=d.id JOIN bots b ON b.id=k.bot_id
    CROSS JOIN development_policy c WHERE d.id=$1 AND c.id=1`,[requestId])).rows[0];
  requireThat(r&&r.decision==='accepted','Accepted knowledge transfer required');return r;
}
function usable(r:Row){return r.supported&&r.enabled&&r.revision===r.policy_revision&&r.state!=='retired'&&!r.halted;}
async function load(tx:Sql,id:string){
  const a=(await tx.query('SELECT *,expires_at>now() AS fresh FROM knowledge_assessments WHERE id=$1',[id])).rows[0];
  requireThat(a,'Assessment not found',404);return a;
}
export class KnowledgeAssessments {
  constructor(private readonly db:Database){}
  create(actor:Actor,key:string,raw:unknown){
    permit(actor,'evaluator');const input=parse(z.object({requestId:z.uuid(),rubric:z.enum(knowledgeRubrics).optional()}).strict(),raw);
    const rubric=input.rubric??skillRubric;
    return this.db.command(actor,'knowledge-assessment-create',key,input,async tx=>{
      const r=await support(tx,input.requestId);requireThat(actor.id!==r.author,'Independent evaluator required');requireThat(usable(r),'Current supported unhalted transfer required');
      requireThat(!(await tx.query('SELECT 1 FROM knowledge_assessments WHERE request_id=$1',[r.id])).rows.length,'Transfer already assessed or assessment pending');
      const policy=(await tx.query('SELECT max_per_day,max_lifetime FROM development_policy WHERE id=1')).rows[0]!;
      const counts=(await tx.query("SELECT count(*)::int AS total,count(*) FILTER(WHERE created_at>now()-interval '24 hours')::int AS daily FROM development_requests")).rows[0]!;
      requireThat(counts.total<policy.max_lifetime&&counts.daily<policy.max_per_day,'Shared development request capacity reached');
      const cases:Case[]=Array.from({length:4},(_,i)=>{const challenge=makeChallenge();challenge.control={halted:i===1,evidenceVerified:i!==2,budget:i===3?0:10,required:10};return {id:uuid(),challenge};});
      const assessmentId=uuid();
      // The basics context shape is unchanged; only method assessments name their rubric in the frozen context.
      const inferenceRequestId=uuid(),context={kind:'knowledge-assessment-v1',assessmentId,requestId:r.id,cases,...(rubric===methodsRubric?{rubric}:{})};
      await assertTokenCapacity(tx,context);
      await tx.query(`INSERT INTO development_requests(id,author,policy_revision,model,context,context_hash,expires_at)
        VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,now()+interval '1 hour')`,[inferenceRequestId,r.author,r.policy_revision,JSON.stringify(r.model),JSON.stringify(context),digest(context)]);
      await tx.query('INSERT INTO knowledge_assessments(id,request_id,evaluator,inference_request_id,cases,rubric) VALUES($1,$2,$3,$4,$5::jsonb,$6)',[assessmentId,r.id,actor.id,inferenceRequestId,JSON.stringify(cases),rubric]);
      await audit(tx,actor,'knowledge.assessment.created',assessmentId,{requestId:r.id,botId:r.bot_id,rubric});
      return {assessmentId,requestId:r.id,rubric,caseCount:4};
    });
  }
  work(actor:Actor,raw:unknown){
    permit(actor,'researcher');const input=parse(ref,raw);
    return this.db.transaction(async tx=>{
      const a=await load(tx,input.assessmentId),r=await support(tx,a.request_id);
      requireThat(r.author===actor.id,'Assigned researcher required',403);requireThat(a.fresh&&usable(r),'Current supported unexpired assessment required');
      requireThat(!(await tx.query('SELECT 1 FROM knowledge_assessment_answers WHERE assessment_id=$1',[a.id])).rows.length,'Answers already submitted');
      const plan=(await tx.query('SELECT proposal FROM bot_knowledge_proposals WHERE request_id=$1',[r.id])).rows[0]!;
      return {assessmentId:a.id,requestId:r.id,inferenceRequestId:a.inference_request_id,botId:r.bot_id,model:r.model,rubric:a.rubric,cases:a.cases,plan:plan.proposal,lessons:r.context.lessons,expiresAt:a.expires_at};
    });
  }
  submit(actor:Actor,key:string,raw:unknown){
    permit(actor,'researcher');const input=parse(z.object({assessmentId:z.uuid(),answers:z.array(z.object({caseId:z.uuid(),answers:z.unknown()}).strict()).length(4)}).strict(),raw);
    return this.db.command(actor,'knowledge-assessment-submit',key,input,async tx=>{
      const a=await load(tx,input.assessmentId),r=await support(tx,a.request_id);
      // The answer contract depends on the stored rubric: numbers for basics, chosen methods for research-methods.
      const contract:z.ZodType<unknown>=a.rubric===methodsRubric?methodAnswers:skillAnswers;
      for(const item of input.answers)parse(contract,item.answers);
      requireThat(r.author===actor.id,'Assigned researcher required',403);requireThat(a.fresh&&usable(r),'Current supported unexpired assessment required');
      requireThat(digest(input.answers.map(x=>x.caseId).sort())===digest((a.cases as Case[]).map(x=>x.id).sort()),'Answer every case exactly once');
      const old=(await tx.query('SELECT answers FROM knowledge_assessment_answers WHERE assessment_id=$1',[a.id])).rows[0];
      if(old)requireThat(digest(old.answers)===digest(input.answers),'Answers already fixed');
      else{await tx.query('INSERT INTO knowledge_assessment_answers(assessment_id,author,answers) VALUES($1,$2,$3::jsonb)',[a.id,actor.id,JSON.stringify(input.answers)]);
        await audit(tx,actor,'knowledge.assessment.submitted',a.id,{requestId:r.id,botId:r.bot_id});}
      return {assessmentId:a.id,state:'awaiting-grade'};
    });
  }
  grade(actor:Actor,key:string,raw:unknown){
    permit(actor,'evaluator');const input=parse(ref,raw);
    return this.db.command(actor,'knowledge-assessment-grade',key,input,async tx=>{
      const a=await load(tx,input.assessmentId),r=await support(tx,a.request_id);
      requireThat(actor.id!==r.author&&actor.id===a.evaluator,'Assigned independent evaluator required',403);
      const old=(await tx.query('SELECT report FROM knowledge_assessment_results WHERE assessment_id=$1',[a.id])).rows[0];if(old)return old.report;
      const submission=(await tx.query('SELECT answers FROM knowledge_assessment_answers WHERE assessment_id=$1',[a.id])).rows[0];requireThat(submission,'Submitted answers required');
      const methods=a.rubric===methodsRubric;
      const answers=submission.answers as {caseId:string;answers:Answers|MethodAnswers}[];
      const numeric=(c:Case)=>{const given=answers.find(x=>x.caseId===c.id)!.answers;
        return methods?deriveAnswers(c.challenge,given as MethodAnswers):given as Answers;};
      const checks=usable(r)?(a.cases as Case[]).map(c=>({caseId:c.id,checks:gradeSkill(c.challenge,numeric(c)),
        ...(methods?{derived:numeric(c)}:{})})):[];
      const passedChecks=checks.reduce((n,c)=>n+Object.values(c.checks).filter(Boolean).length,0);
      const report={assessmentId:a.id,requestId:r.id,botId:r.bot_id,rubric:a.rubric,
        ...(methods?{scoring:'Backend derived every number from the chosen methods, then applied research-basics grading.'}:{}),
        outcome:!checks.length?'invalidated':passedChecks===16?'passed':'failed',passedChecks,totalChecks:16,cases:checks,
        causalImprovementEstablished:false,verifiedModelExecution:false,fitnessChanged:false,
        limitation:'Fresh synthetic task performance after transfer; no before/after control, generalisation, profitability or verified model execution claim.'};
      await tx.query('INSERT INTO knowledge_assessment_results(assessment_id,evaluator,report) VALUES($1,$2,$3::jsonb)',[a.id,actor.id,JSON.stringify(report)]);
      await audit(tx,actor,'knowledge.assessment.graded',a.id,{botId:r.bot_id,outcome:report.outcome,passedChecks});return report;
    });
  }
}
