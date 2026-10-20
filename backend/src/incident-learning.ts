import {z} from 'zod';
import {Actor,id,parse,permit,requireThat,text,uuid} from './core.js';
import {Database,Sql,audit} from './database.js';

export async function incidentAssignmentActive(tx:Sql,requestId:string){
  requireThat(!(await tx.query(`SELECT 1 FROM incident_learning_attempts t
    JOIN incident_learning_cancellations c ON c.assignment_id=t.assignment_id WHERE t.request_id=$1`,[requestId])).rows.length,
    'Incident learning assignment was cancelled');
}

async function supported(tx:Sql,lessonId:string){
  const l=(await tx.query(`SELECT l.bot_id FROM lessons l JOIN incident_lessons il ON il.lesson_id=l.id
    JOIN evidence e ON e.id=l.evidence_id JOIN sources s ON s.id=e.source_id
    WHERE l.id=$1 AND l.status='verified' AND e.status='verified' AND s.approved AND e.published_at<=now()`,[lessonId])).rows[0];
  requireThat(l,'Currently supported reviewed incident lesson required');return l;
}
export class IncidentLearning {
  constructor(private readonly db:Database){}
  claim(actor:Actor,key:string,raw:unknown){
    permit(actor,'researcher');const input=parse(z.object({}).strict(),raw);
    return this.db.command(actor,'incident-learning-claim',key,input,async tx=>{
      requireThat(!(await tx.query('SELECT halted FROM system_lock WHERE id=1')).rows[0]!.halted,'System halted');
      requireThat((await tx.query('SELECT id FROM development_policy WHERE id=1 AND enabled=true AND model IS NOT NULL')).rows.length,'Enabled model policy required');
      const busy=(await tx.query(`SELECT 1 FROM incident_learning_leases lease WHERE lease.worker=$1 AND lease.expires_at>now()
        AND NOT EXISTS(SELECT 1 FROM incident_learning_attempts t WHERE t.assignment_id=lease.assignment_id)
        AND NOT EXISTS(SELECT 1 FROM incident_learning_cancellations c WHERE c.assignment_id=lease.assignment_id)`,[actor.id])).rows.length;
      if(busy)return {assignment:null};
      const a=(await tx.query(`SELECT a.id,a.bot_id,a.lesson_id,a.task FROM incident_learning_assignments a
        JOIN bots b ON b.id=a.bot_id JOIN lessons l ON l.id=a.lesson_id JOIN evidence e ON e.id=l.evidence_id
        JOIN sources s ON s.id=e.source_id LEFT JOIN incident_learning_leases lease ON lease.assignment_id=a.id
        WHERE b.state<>'retired' AND l.status='verified' AND e.status='verified' AND s.approved AND e.published_at<=now()
        AND NOT EXISTS(SELECT 1 FROM incident_learning_cancellations c WHERE c.assignment_id=a.id)
        AND NOT EXISTS(SELECT 1 FROM incident_learning_attempts t WHERE t.assignment_id=a.id)
        AND (lease.assignment_id IS NULL OR (lease.expires_at<=now() AND lease.attempts<3))
        ORDER BY a.created_at,a.id LIMIT 1`)).rows[0];
      if(!a)return {assignment:null};
      const token=uuid();
      const lease=(await tx.query(`INSERT INTO incident_learning_leases(assignment_id,worker,token,expires_at,attempts)
        VALUES($1,$2,$3,now()+interval '5 minutes',1) ON CONFLICT(assignment_id) DO UPDATE SET
        worker=EXCLUDED.worker,token=EXCLUDED.token,expires_at=EXCLUDED.expires_at,attempts=incident_learning_leases.attempts+1
        RETURNING expires_at,attempts`,[a.id,actor.id,token])).rows[0]!;
      await audit(tx,actor,'incident.learning.claimed',a.id,{attempt:lease.attempts});
      return {assignment:{id:a.id,botId:a.bot_id,lessonIds:[a.lesson_id],task:a.task,leaseToken:token,expiresAt:lease.expires_at,attempt:lease.attempts}};
    });
  }
  cancel(actor:Actor,key:string,raw:unknown){
    permit(actor,'owner');const input=parse(z.object({assignmentId:z.uuid(),reason:text}).strict(),raw);
    return this.db.command(actor,'incident-learning-cancel',key,input,async tx=>{
      requireThat((await tx.query('SELECT id FROM incident_learning_assignments WHERE id=$1',[input.assignmentId])).rows.length,'Assignment not found',404);
      requireThat(!(await tx.query('SELECT assignment_id FROM incident_learning_cancellations WHERE assignment_id=$1',[input.assignmentId])).rows.length,'Assignment already cancelled');
      await tx.query('INSERT INTO incident_learning_cancellations(assignment_id,author,reason) VALUES($1,$2,$3)',[input.assignmentId,actor.id,input.reason]);
      await audit(tx,actor,'incident.learning.cancelled',input.assignmentId,{reason:input.reason});
      return {assignmentId:input.assignmentId,state:'cancelled',historyPreserved:true};
    });
  }
  assign(actor:Actor,key:string,raw:unknown){
    permit(actor,'owner');const input=parse(z.object({lessonId:z.uuid(),botIds:z.array(id).min(1).max(20).refine(a=>new Set(a).size===a.length),task:z.string().trim().min(1).max(500)}).strict(),raw);
    return this.db.command(actor,'incident-learning-assign',key,input,async tx=>{
      const lesson=await supported(tx,input.lessonId);
      const count=(await tx.query('SELECT count(*)::int AS n FROM incident_learning_assignments WHERE lesson_id=$1',[input.lessonId])).rows[0]!.n;
      requireThat(count+input.botIds.length<=100,'Incident lesson assignment capacity reached');
      const assignments=[];
      for(const botId of input.botIds){
        requireThat(botId!==lesson.bot_id,'Assign cross-bot learning to a different bot');
        requireThat((await tx.query("SELECT id FROM bots WHERE id=$1 AND state<>'retired'",[botId])).rows.length,'Active recipient bot required');
        requireThat(!(await tx.query('SELECT id FROM incident_learning_assignments WHERE lesson_id=$1 AND bot_id=$2',[input.lessonId,botId])).rows.length,'Bot already assigned this lesson');
        const assignmentId=uuid();
        await tx.query('INSERT INTO incident_learning_assignments(id,lesson_id,bot_id,task,author) VALUES($1,$2,$3,$4,$5)',[assignmentId,input.lessonId,botId,input.task,actor.id]);
        await audit(tx,actor,'incident.learning.assigned',assignmentId,{lessonId:input.lessonId,botId});
        assignments.push({id:assignmentId,botId});
      }
      return {assignments,modelInvoked:false,fitnessChanged:false};
    });
  }
  link(actor:Actor,key:string,raw:unknown){
    permit(actor,'researcher');const input=parse(z.object({assignmentId:z.uuid(),requestId:z.uuid(),leaseToken:z.uuid().optional()}).strict(),raw);
    return this.db.command(actor,'incident-learning-link',key,input,async tx=>{
      const a=(await tx.query('SELECT * FROM incident_learning_assignments WHERE id=$1',[input.assignmentId])).rows[0];
      requireThat(a,'Assignment not found',404);
      requireThat(!(await tx.query('SELECT assignment_id FROM incident_learning_cancellations WHERE assignment_id=$1',[a.id])).rows.length,'Incident learning assignment was cancelled');
      await supported(tx,a.lesson_id);
      const lease=(await tx.query('SELECT *,expires_at>now() AS fresh FROM incident_learning_leases WHERE assignment_id=$1',[a.id])).rows[0];
      const linked=(await tx.query('SELECT 1 FROM incident_learning_attempts WHERE assignment_id=$1 LIMIT 1',[a.id])).rows.length;
      if(lease&&!linked)requireThat(lease.worker===actor.id&&lease.token===input.leaseToken&&lease.fresh,'Current assigned lease required',403);
      if(!lease)requireThat(!input.leaseToken,'Assignment has no lease');
      const r=(await tx.query(`SELECT d.author,d.created_at,k.bot_id,d.context FROM development_requests d
        JOIN bot_knowledge_requests k ON k.request_id=d.id WHERE d.id=$1`,[input.requestId])).rows[0];
      requireThat(r&&r.author===actor.id,'Assigned request author required',403);
      requireThat(r.bot_id===a.bot_id&&new Date(r.created_at)>=new Date(a.created_at)&&r.context.task===a.task,'Fresh request for assigned bot and exact task required');
      requireThat((await tx.query('SELECT 1 FROM bot_knowledge_lessons WHERE request_id=$1 AND lesson_id=$2',[input.requestId,a.lesson_id])).rows.length,'Assigned lesson must be included');
      requireThat((await tx.query("SELECT id FROM bots WHERE id=$1 AND state<>'retired'",[a.bot_id])).rows.length,'Active recipient bot required');
      const old=(await tx.query('SELECT assignment_id FROM incident_learning_attempts WHERE request_id=$1',[input.requestId])).rows[0];
      if(old){requireThat(old.assignment_id===a.id,'Request already linked');return {assignmentId:a.id,requestId:input.requestId};}
      requireThat((await tx.query('SELECT count(*)::int AS n FROM incident_learning_attempts WHERE assignment_id=$1',[a.id])).rows[0]!.n<10,'Assignment attempt capacity reached');
      await tx.query('INSERT INTO incident_learning_attempts(assignment_id,request_id) VALUES($1,$2)',[a.id,input.requestId]);
      await audit(tx,actor,'incident.learning.linked',a.id,{requestId:input.requestId});return {assignmentId:a.id,requestId:input.requestId};
    });
  }
  progress(actor:Actor,raw:unknown){
    permit(actor,'owner','researcher','evaluator');const input=parse(z.object({lessonId:z.uuid()}).strict(),raw);
    return this.db.transaction(async tx=>({assignments:(await tx.query(`SELECT a.*,b.state AS bot_state,c.reason AS cancellation_reason,c.created_at AS cancelled_at,
      lease.worker AS lease_worker,lease.expires_at AS lease_expires_at,lease.attempts AS claim_attempts,
      CASE WHEN c.assignment_id IS NOT NULL THEN 'cancelled' WHEN b.state='retired' THEN 'recipient-retired'
        WHEN NOT (l.status='verified' AND e.status='verified' AND s.approved AND e.published_at<=now()) THEN 'support-withdrawn' ELSE 'active' END AS assignment_state,
      (l.status='verified' AND e.status='verified' AND s.approved AND e.published_at<=now()) AS support_current
      FROM incident_learning_assignments a JOIN bots b ON b.id=a.bot_id JOIN lessons l ON l.id=a.lesson_id
      JOIN evidence e ON e.id=l.evidence_id JOIN sources s ON s.id=e.source_id
      LEFT JOIN incident_learning_cancellations c ON c.assignment_id=a.id
      LEFT JOIN incident_learning_leases lease ON lease.assignment_id=a.id WHERE a.lesson_id=$1 ORDER BY a.created_at,a.id`,[input.lessonId])).rows,
      attempts:(await tx.query(`SELECT t.assignment_id,t.request_id,r.decision,a.id AS assessment_id,result.report,
        (p.enabled AND p.revision=d.policy_revision AND NOT lock.halted AND b.state<>'retired'
          AND NOT EXISTS(SELECT 1 FROM incident_learning_cancellations c WHERE c.assignment_id=assignment.id)
          AND NOT EXISTS(SELECT 1 FROM bot_knowledge_lessons x JOIN lessons l ON l.id=x.lesson_id
            JOIN evidence e ON e.id=l.evidence_id JOIN sources s ON s.id=e.source_id WHERE x.request_id=t.request_id
            AND (l.status<>'verified' OR e.status<>'verified' OR NOT s.approved OR e.published_at>now()))) AS context_current
        FROM incident_learning_attempts t JOIN incident_learning_assignments assignment ON assignment.id=t.assignment_id
        JOIN development_requests d ON d.id=t.request_id JOIN bots b ON b.id=assignment.bot_id
        CROSS JOIN development_policy p CROSS JOIN system_lock lock
        LEFT JOIN bot_knowledge_reviews r ON r.request_id=t.request_id
        LEFT JOIN knowledge_assessments a ON a.request_id=t.request_id
        LEFT JOIN knowledge_assessment_results result ON result.assessment_id=a.id
        WHERE assignment.lesson_id=$1 AND p.id=1 AND lock.id=1 ORDER BY t.created_at,t.request_id`,[input.lessonId])).rows,
      scope:'assignment-and-synthetic-assessment-history',incidentMasteryEstablished:false,fitnessChanged:false}));
  }
}
