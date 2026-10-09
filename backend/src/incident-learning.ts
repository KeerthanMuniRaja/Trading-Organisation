import {z} from 'zod';
import {Actor,id,parse,permit,requireThat,uuid} from './core.js';
import {Database,Sql,audit} from './database.js';

async function supported(tx:Sql,lessonId:string){
  const l=(await tx.query(`SELECT l.bot_id FROM lessons l JOIN incident_lessons il ON il.lesson_id=l.id
    JOIN evidence e ON e.id=l.evidence_id JOIN sources s ON s.id=e.source_id
    WHERE l.id=$1 AND l.status='verified' AND e.status='verified' AND s.approved AND e.published_at<=now()`,[lessonId])).rows[0];
  requireThat(l,'Currently supported reviewed incident lesson required');return l;
}
export class IncidentLearning {
  constructor(private readonly db:Database){}
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
    permit(actor,'researcher');const input=parse(z.object({assignmentId:z.uuid(),requestId:z.uuid()}).strict(),raw);
    return this.db.command(actor,'incident-learning-link',key,input,async tx=>{
      const a=(await tx.query('SELECT * FROM incident_learning_assignments WHERE id=$1',[input.assignmentId])).rows[0];
      requireThat(a,'Assignment not found',404);await supported(tx,a.lesson_id);
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
    return this.db.transaction(async tx=>({assignments:(await tx.query(`SELECT a.*,b.state AS bot_state,
      (l.status='verified' AND e.status='verified' AND s.approved AND e.published_at<=now()) AS support_current
      FROM incident_learning_assignments a JOIN bots b ON b.id=a.bot_id JOIN lessons l ON l.id=a.lesson_id
      JOIN evidence e ON e.id=l.evidence_id JOIN sources s ON s.id=e.source_id WHERE a.lesson_id=$1 ORDER BY a.created_at,a.id`,[input.lessonId])).rows,
      attempts:(await tx.query(`SELECT t.assignment_id,t.request_id,r.decision,a.id AS assessment_id,result.report,
        (p.enabled AND p.revision=d.policy_revision AND NOT lock.halted AND b.state<>'retired'
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
