import { z } from 'zod';
import { Actor,id,parse,permit,requireThat,text,uuid } from './core.js';
import { audit,Database,Row,Sql } from './database.js';
const ref=z.object({workflowId:z.uuid()}).strict();
async function state(tx:Sql,workflowId:string){
  const w=(await tx.query(`SELECT w.*,c.reason AS cancelled_reason,p.enabled,p.revision,
    l.halted,(m.state<>'retired' AND b.state<>'retired' AND e.status='verified' AND s.approved AND e.published_at<=now()) AS supported
    FROM learning_workflows w CROSS JOIN development_policy p CROSS JOIN system_lock l
    JOIN bots m ON m.id=w.mentor_id JOIN bots b ON b.id=w.recipient_id
    JOIN evidence e ON e.id=w.evidence_id JOIN sources s ON s.id=e.source_id
    LEFT JOIN learning_workflow_cancellations c ON c.workflow_id=w.id WHERE w.id=$1`,[workflowId])).rows[0];
  requireThat(w,'Learning workflow not found',404);
  const links=(await tx.query('SELECT step,reference_id FROM learning_workflow_links WHERE workflow_id=$1',[w.id])).rows;
  const ids=Object.fromEntries(links.map(r=>[r.step,r.reference_id]));
  const source=ids.source?(await tx.query(`SELECT p.lesson_id,r.decision FROM source_learning_proposals p
    LEFT JOIN source_learning_reviews r ON r.request_id=p.request_id WHERE p.request_id=$1`,[ids.source])).rows[0]:undefined;
  const transfer=ids.transfer?(await tx.query(`SELECT p.request_id,r.decision FROM bot_knowledge_proposals p
    LEFT JOIN bot_knowledge_reviews r ON r.request_id=p.request_id WHERE p.request_id=$1`,[ids.transfer])).rows[0]:undefined;
  const assessment=ids.assessment?(await tx.query(`SELECT a.*,s.assessment_id IS NOT NULL AS submitted,r.report FROM knowledge_assessments a
    LEFT JOIN knowledge_assessment_answers s ON s.assessment_id=a.id LEFT JOIN knowledge_assessment_results r ON r.assessment_id=a.id WHERE a.id=$1`,[ids.assessment])).rows[0]:undefined;
  return {w,ids,source,transfer,assessment};
}
function authorised(w:Row,actor:Actor){requireThat(actor.role==='owner'||actor.role==='researcher'&&actor.id===w.researcher||actor.role==='evaluator'&&actor.id===w.evaluator,'Assigned workflow identity required',403);}
function block(w:Row){return w.cancelled_reason?'cancelled':w.halted?'halted':!w.enabled||w.revision!==w.policy_revision?'policy-changed':!w.supported?'support-withdrawn':null;}
export class LearningWorkflows {
  constructor(private readonly db:Database){}
  register(actor:Actor,key:string,raw:unknown){
    permit(actor,'owner');const input=parse(z.object({mentorId:id,recipientId:id,evidenceId:z.uuid(),researcherId:id,evaluatorId:id,task:z.string().trim().min(1).max(500),
      assessmentRubric:z.enum(['research-basics-v1','research-methods-v1']).optional()}).strict(),raw);
    requireThat(input.mentorId!==input.recipientId&&input.researcherId!==input.evaluatorId&&![input.researcherId,input.evaluatorId].includes(actor.id),'Distinct bots and independent service identities required',400);
    return this.db.command(actor,'learning-workflow-register',key,input,async tx=>{
      const p=(await tx.query('SELECT * FROM development_policy WHERE id=1')).rows[0]!;
      requireThat(p.enabled&&p.model,'Enabled development model policy required');
      requireThat(!(await tx.query('SELECT halted FROM system_lock WHERE id=1')).rows[0]!.halted,'System halted');
      requireThat((await tx.query("SELECT id FROM bots WHERE id=ANY($1::text[]) AND state<>'retired'",[[input.mentorId,input.recipientId]])).rows.length===2,'Active mentor and recipient required');
      requireThat((await tx.query(`SELECT 1 FROM source_observations o JOIN evidence e ON e.id=o.evidence_id JOIN sources s ON s.id=e.source_id
        WHERE e.id=$1 AND e.status='verified' AND s.approved AND e.published_at<=now()`,[input.evidenceId])).rows.length,'Reviewed source observation required');
      const counts=(await tx.query("SELECT count(*)::int AS total,count(*) FILTER(WHERE created_at>now()-interval '24 hours')::int AS daily FROM learning_workflows")).rows[0]!;
      requireThat(counts.total<100&&counts.daily<10,'Learning workflow capacity reached');
      const workflowId=uuid();await tx.query(`INSERT INTO learning_workflows(id,owner_id,researcher,evaluator,mentor_id,recipient_id,evidence_id,task,policy_revision,assessment_rubric)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[workflowId,actor.id,input.researcherId,input.evaluatorId,input.mentorId,input.recipientId,input.evidenceId,input.task,p.revision,
        input.assessmentRubric??'research-basics-v1']);
      await audit(tx,actor,'learning.workflow.registered',workflowId,input);return {workflowId,scope:'bounded-research-learning',automaticReview:false};
    });
  }
  progress(actor:Actor,raw:unknown){
    permit(actor,'owner','researcher','evaluator');const input=parse(ref,raw);
    return this.db.transaction(async tx=>{
      const {w,ids,source,transfer,assessment}=await state(tx,input.workflowId);authorised(w,actor);
      const common={workflowId:w.id,links:ids,assessment:assessment?.report??null,automaticReview:false};
      const blocked=block(w);if(blocked)return {...common,state:blocked,action:null};
      if(source?.decision==='rejected'||transfer?.decision==='rejected')return {...common,state:'rejected',action:null};
      if(assessment?.report)return {...common,state:'completed',action:null};
      let role='researcher',stage='source';let body:Row={botId:w.mentor_id,evidenceId:w.evidence_id};
      if(source){
        if(!source.decision)return {...common,state:'awaiting-source-review',action:null};
        stage='transfer';body={botId:w.recipient_id,lessonIds:[source.lesson_id],task:w.task};
      }
      if(transfer){
        if(!transfer.decision)return {...common,state:'awaiting-transfer-review',action:null};
        // Basics workflows keep their original body so in-flight idempotent retries still match.
        stage='assessment-create';role='evaluator';body={requestId:ids.transfer,...(w.assessment_rubric!=='research-basics-v1'?{rubric:w.assessment_rubric}:{})};
      }
      if(assessment){
        stage=assessment.submitted?'assessment-grade':'assessment-answer';role=assessment.submitted?'evaluator':'researcher';body={assessmentId:ids.assessment};
        if(!assessment.submitted&&new Date(assessment.expires_at).getTime()<=Date.now())return {...common,state:'assessment-expired',action:null};
      }
      return {...common,state:stage,requiredRole:role,action:actor.role===role?{stage,body,requestKey:'workflow-'+w.id+'-'+stage}:null};
    });
  }
  attach(actor:Actor,key:string,raw:unknown){
    permit(actor,'researcher','evaluator');const input=parse(z.object({workflowId:z.uuid(),step:z.enum(['source','transfer','assessment']),referenceId:z.uuid()}).strict(),raw);
    return this.db.command(actor,'learning-workflow-attach',key,input,async tx=>{
      const {w,ids,source,transfer}=await state(tx,input.workflowId);authorised(w,actor);requireThat(!block(w),'Workflow is paused, cancelled or unsupported');
      requireThat(actor.role===(input.step==='assessment'?'evaluator':'researcher'),'Wrong workflow stage role',403);
      if(ids[input.step]){requireThat(ids[input.step]===input.referenceId,'Workflow stage already fixed');return {linked:true};}
      requireThat(!(await tx.query('SELECT 1 FROM learning_workflow_links WHERE reference_id=$1',[input.referenceId])).rows.length,'Stage record is already attached to another workflow');
      if(input.step==='source'){
        const p=(await tx.query(`SELECT s.*,d.author,d.policy_revision FROM source_learning_requests s JOIN development_requests d ON d.id=s.request_id
          JOIN source_learning_proposals p ON p.request_id=s.request_id WHERE s.request_id=$1`,[input.referenceId])).rows[0];
        requireThat(p&&p.author===w.researcher&&p.policy_revision===w.policy_revision&&p.bot_id===w.mentor_id&&p.evidence_id===w.evidence_id,'Source stage does not match workflow');
      }else if(input.step==='transfer'){
        requireThat(source?.decision==='accepted','Accepted source lesson required');
        const p=(await tx.query(`SELECT k.*,d.author,d.context,d.policy_revision FROM bot_knowledge_requests k JOIN development_requests d ON d.id=k.request_id
          JOIN bot_knowledge_proposals p ON p.request_id=k.request_id WHERE k.request_id=$1`,[input.referenceId])).rows[0];
        requireThat(p&&p.author===w.researcher&&p.policy_revision===w.policy_revision&&p.bot_id===w.recipient_id&&p.context.task===w.task&&p.context.lessons.length===1&&p.context.lessons[0].id===source.lesson_id,'Transfer stage does not match workflow');
      }else{
        requireThat(transfer?.decision==='accepted','Accepted transfer required');
        const a=(await tx.query('SELECT * FROM knowledge_assessments WHERE id=$1',[input.referenceId])).rows[0];
        requireThat(a&&a.request_id===ids.transfer&&a.evaluator===w.evaluator&&a.rubric===w.assessment_rubric,'Assessment stage does not match workflow');
      }
      await tx.query('INSERT INTO learning_workflow_links(workflow_id,step,reference_id) VALUES($1,$2,$3)',[w.id,input.step,input.referenceId]);
      await audit(tx,actor,'learning.workflow.linked',w.id,input);return {linked:true};
    });
  }
  cancel(actor:Actor,key:string,raw:unknown){
    permit(actor,'owner');const input=parse(z.object({workflowId:z.uuid(),reason:text}).strict(),raw);
    return this.db.command(actor,'learning-workflow-cancel',key,input,async tx=>{
      await state(tx,input.workflowId);const old=(await tx.query('SELECT reason FROM learning_workflow_cancellations WHERE workflow_id=$1',[input.workflowId])).rows[0];
      if(old)requireThat(old.reason===input.reason,'Cancellation reason already fixed');
      else{await tx.query('INSERT INTO learning_workflow_cancellations VALUES($1,$2,$3,now())',[input.workflowId,input.reason,actor.id]);await audit(tx,actor,'learning.workflow.cancelled',input.workflowId,{reason:input.reason});}
      return {workflowId:input.workflowId,state:'cancelled',scope:'stops-workflow-progression-not-issued-request-authority'};
    });
  }
}
