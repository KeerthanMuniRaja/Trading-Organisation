import { z } from 'zod';
import { Actor, id, parse, permit, requireThat, text, uuid } from './core.js';
import { Database, Sql, audit } from './database.js';
import { verifiedEvidence } from './organisation.js';

export async function incidentResolutionReady(tx:Sql,incidentId:string,evidenceId:string) {
  const latest=(await tx.query(`SELECT f.evidence_id,r.decision FROM incident_findings f
    LEFT JOIN incident_finding_reviews r ON r.finding_id=f.id WHERE f.incident_id=$1 ORDER BY f.sequence DESC LIMIT 1`,[incidentId])).rows[0];
  if(latest)requireThat(latest.decision==='accepted'&&latest.evidence_id===evidenceId,
    'Resolve using the latest independently accepted finding and its supporting evidence');
}

export class IncidentReview {
  constructor(private readonly db:Database){}
  lesson(actor:Actor,key:string,raw:unknown){
    permit(actor,'owner','researcher');
    const input=parse(z.object({findingId:z.uuid(),botId:id,content:text}).strict(),raw);
    return this.db.command(actor,'incident-lesson',key,input,async tx=>{
      const finding=(await tx.query(`SELECT f.*,i.status,r.decision FROM incident_findings f
        JOIN incidents i ON i.id=f.incident_id JOIN incident_finding_reviews r ON r.finding_id=f.id
        WHERE f.id=$1`,[input.findingId])).rows[0];
      requireThat(finding&&finding.status==='resolved'&&finding.decision==='accepted','Accepted finding from a resolved incident required');
      await incidentResolutionReady(tx,finding.incident_id,finding.evidence_id);
      requireThat(!(await tx.query('SELECT id FROM incident_findings WHERE incident_id=$1 AND sequence>$2',[finding.incident_id,finding.sequence])).rows.length,'Latest finding required');
      await verifiedEvidence(tx,finding.evidence_id);
      requireThat((await tx.query("SELECT id FROM bots WHERE id=$1 AND state<>'retired'",[input.botId])).rows.length,'Active bot required');
      requireThat(!(await tx.query('SELECT lesson_id FROM incident_lessons WHERE finding_id=$1',[finding.id])).rows.length,'Finding already has a lesson; reuse its reviewed knowledge');
      const lessonId=uuid();
      await tx.query("INSERT INTO lessons(id,bot_id,content,evidence_id,status,author) VALUES($1,$2,$3,$4,'unverified',$5)",[lessonId,input.botId,input.content,finding.evidence_id,actor.id]);
      await tx.query('INSERT INTO incident_lessons(finding_id,lesson_id) VALUES($1,$2)',[finding.id,lessonId]);
      await audit(tx,actor,'incident.lesson.proposed',lessonId,{findingId:finding.id,incidentId:finding.incident_id,botId:input.botId});
      return {id:lessonId,status:'unverified',findingId:finding.id,learningApplied:false};
    });
  }
  propose(actor:Actor,key:string,raw:unknown){
    permit(actor,'owner','researcher','evaluator');
    const input=parse(z.object({incidentId:z.uuid(),evidenceId:z.uuid(),rootCause:text,correctiveAction:text,
      prevention:text,verificationPlan:text}).strict(),raw);
    return this.db.command(actor,'incident-finding',key,input,async tx=>{
      requireThat((await tx.query("SELECT id FROM incidents WHERE id=$1 AND status='open'",[input.incidentId])).rows.length,'Open incident required');
      await verifiedEvidence(tx,input.evidenceId);
      requireThat((await tx.query('SELECT count(*)::int AS n FROM incident_findings WHERE incident_id=$1',[input.incidentId])).rows[0]!.n<10,'Incident finding capacity reached');
      requireThat(!(await tx.query(`SELECT f.id FROM incident_findings f LEFT JOIN incident_finding_reviews r ON r.finding_id=f.id
        WHERE f.incident_id=$1 AND r.finding_id IS NULL`,[input.incidentId])).rows.length,'Review the pending finding before proposing a correction');
      const id=uuid();
      await tx.query(`INSERT INTO incident_findings(id,incident_id,evidence_id,root_cause,corrective_action,prevention,verification_plan,author)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[id,input.incidentId,input.evidenceId,input.rootCause,input.correctiveAction,input.prevention,input.verificationPlan,actor.id]);
      await audit(tx,actor,'incident.finding.proposed',id,{incidentId:input.incidentId,evidenceId:input.evidenceId});
      return {id,status:'awaiting-review',actionsExecuted:false};
    });
  }
  review(actor:Actor,key:string,raw:unknown){
    permit(actor,'owner','evaluator');
    const input=parse(z.object({findingId:z.uuid(),decision:z.enum(['accepted','rejected']),reason:text}).strict(),raw);
    return this.db.command(actor,'incident-finding-review',key,input,async tx=>{
      const f=(await tx.query(`SELECT f.*,i.reporter,i.status FROM incident_findings f JOIN incidents i ON i.id=f.incident_id WHERE f.id=$1`,[input.findingId])).rows[0];
      requireThat(f&&f.status==='open','Finding for an open incident required');
      requireThat(f.author!==actor.id&&f.reporter!==actor.id,'Reviewer must differ from finding author and incident reporter',403);
      requireThat(!(await tx.query('SELECT finding_id FROM incident_finding_reviews WHERE finding_id=$1',[f.id])).rows.length,'Finding already reviewed; append a correction');
      if(input.decision==='accepted')await verifiedEvidence(tx,f.evidence_id);
      await tx.query('INSERT INTO incident_finding_reviews(finding_id,decision,reason,reviewer) VALUES($1,$2,$3,$4)',[f.id,input.decision,input.reason,actor.id]);
      await audit(tx,actor,'incident.finding.'+input.decision,f.id,{incidentId:f.incident_id,reason:input.reason});
      return {id:f.id,decision:input.decision,resolved:false,resumeRequired:true,actionsExecuted:false};
    });
  }
  list(actor:Actor,raw:unknown){
    permit(actor,'owner','researcher','evaluator');const input=parse(z.object({incidentId:z.uuid()}).strict(),raw);
    return this.db.transaction(async tx=>({findings:(await tx.query(`SELECT f.*,r.decision,r.reason,r.reviewer,r.reviewed_at,il.lesson_id,l.status AS lesson_status,
      (e.status='verified' AND s.approved) AS support_current FROM incident_findings f
      JOIN evidence e ON e.id=f.evidence_id JOIN sources s ON s.id=e.source_id
      LEFT JOIN incident_finding_reviews r ON r.finding_id=f.id
      LEFT JOIN incident_lessons il ON il.finding_id=f.id LEFT JOIN lessons l ON l.id=il.lesson_id
      WHERE f.incident_id=$1 ORDER BY f.sequence`,[input.incidentId])).rows,
      scope:'reviewed-incident-analysis-not-executed-remediation'}));
  }
}
