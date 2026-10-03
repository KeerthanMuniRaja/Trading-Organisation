import { z } from 'zod';
import { Actor, digest, id, parse, permit, requireThat, text, uuid } from './core.js';
import { audit, Database, Sql } from './database.js';
import { curriculumStatus } from './research-eligibility.js';

// Recheck the support each time an exception is used, including after submission.
// A consumed grant can support its own exam, never another attempt.
export async function currentSkillRecovery(tx:Sql,botId:string,revision:number,recoveryId?:string) {
  const row=(await tx.query(`SELECT g.*,l.content,l.author,l.reviewer,l.evidence_id FROM skill_recoveries g
    JOIN lessons l ON l.id=g.lesson_id JOIN evidence e ON e.id=l.evidence_id JOIN sources s ON s.id=e.source_id
    JOIN bot_curriculum c ON c.bot_id=g.bot_id AND c.lesson_id=g.lesson_id
    LEFT JOIN skill_recovery_revocations v ON v.recovery_id=g.id
    LEFT JOIN skill_recovery_attempts used ON used.recovery_id=g.id
    WHERE g.bot_id=$1 AND g.policy_revision=$2 AND g.expires_at>clock_timestamp()
    AND v.recovery_id IS NULL AND l.status='verified' AND e.status='verified' AND s.approved=true
    AND (($3::uuid IS NULL AND used.attempt_id IS NULL) OR g.id=$3::uuid)`,[botId,revision,recoveryId??null])).rows[0];
  return row&&row.lesson_fingerprint===digest({content:row.content,author:row.author,reviewer:row.reviewer,evidenceId:row.evidence_id})?row:undefined;
}

export async function schoolSkillBudget(tx:Sql,botId:string,revision:number) {
  const counts=(await tx.query(`SELECT count(*)::int AS count,count(*) FILTER(WHERE a.policy_revision=$2 AND r.attempt_id IS NULL
    AND (s.attempt_id IS NOT NULL OR a.expires_at>clock_timestamp()))::int AS pending FROM skill_attempts a
    LEFT JOIN skill_submissions s ON s.attempt_id=a.id LEFT JOIN skill_reviews r ON r.attempt_id=a.id WHERE a.bot_id=$1`,[botId,revision])).rows[0]!;
  const attempts=counts.count as number;
  const recovery=attempts===3?await currentSkillRecovery(tx,botId,revision):undefined;
  return {attemptsUsed:attempts,baseRemaining:Math.max(0,3-attempts),awaitingOutcome:counts.pending>0,recoveryAvailable:Boolean(recovery),recoveryId:recovery?.id as string|undefined};
}

export class SkillRecovery {
  constructor(private readonly db:Database) {}
  approve(actor:Actor,key:string,raw:unknown) {
    permit(actor,'owner');const input=parse(z.object({botId:id,failedAttemptId:z.uuid(),lessonId:z.uuid(),
      expectedPolicyRevision:z.number().int().min(0),reason:text}).strict(),raw);
    return this.db.command(actor,'skill-recovery-approve',key,input,async tx=>{
      const policy=(await tx.query('SELECT * FROM skill_policy WHERE id=1')).rows[0]!;
      requireThat(policy.enabled&&policy.revision===input.expectedPolicyRevision,'Current enabled skill policy required');
      requireThat(!(await tx.query('SELECT halted FROM system_lock WHERE id=1')).rows[0]!.halted,'System halted');
      requireThat((await tx.query("SELECT id FROM bots WHERE id=$1 AND lifecycle_managed=true AND state='school'",[input.botId])).rows.length,'Managed school student required');
      requireThat((await curriculumStatus(tx,input.botId)).valid,'Current verified curriculum required');
      requireThat(!(await tx.query('SELECT id FROM skill_recoveries WHERE bot_id=$1',[input.botId])).rows.length,'One recovery approval per student lifetime');
      const budget=await schoolSkillBudget(tx,input.botId,policy.revision);
      requireThat(budget.attemptsUsed===3,'Recovery requires exactly three consumed attempts');
      const latest=(await tx.query(`SELECT a.*,r.outcome,r.created_at AS reviewed_at FROM skill_attempts a
        LEFT JOIN skill_reviews r ON r.attempt_id=a.id WHERE a.bot_id=$1 ORDER BY a.created_at DESC,a.id DESC LIMIT 1`,[input.botId])).rows[0]!;
      requireThat(latest.id===input.failedAttemptId&&latest.outcome==='failed'&&latest.policy_revision===policy.revision,'Latest attempt must be a graded failure under the current policy');
      const pending=(await tx.query(`SELECT a.id FROM skill_attempts a LEFT JOIN skill_submissions s ON s.attempt_id=a.id
        LEFT JOIN skill_reviews r ON r.attempt_id=a.id WHERE a.bot_id=$1 AND r.attempt_id IS NULL
        AND (s.attempt_id IS NOT NULL OR a.expires_at>clock_timestamp())`,[input.botId])).rows;
      requireThat(!pending.length,'Resolve outstanding exams before recovery');
      const lesson=(await tx.query(`SELECT l.* FROM lessons l JOIN evidence e ON e.id=l.evidence_id JOIN sources s ON s.id=e.source_id
        WHERE l.id=$1 AND l.bot_id=$2 AND l.status='verified' AND e.status='verified' AND s.approved=true`,[input.lessonId,input.botId])).rows[0];
      requireThat(lesson,'Verified corrective lesson for this student required');
      requireThat(lesson.author!==lesson.reviewer&&lesson.reviewer!==actor.id,'Corrective lesson needs an independent reviewer');
      requireThat(new Date(lesson.created_at)>=new Date(latest.reviewed_at),'Corrective lesson must follow the latest failure');
      requireThat(!(await tx.query('SELECT lesson_id FROM bot_curriculum WHERE bot_id=$1 AND lesson_id=$2',[input.botId,input.lessonId])).rows.length,'Corrective lesson must be new to the curriculum');
      const recoveryId=uuid();
      const fingerprint=digest({content:lesson.content,author:lesson.author,reviewer:lesson.reviewer,evidenceId:lesson.evidence_id});
      const grant=(await tx.query(`INSERT INTO skill_recoveries(id,bot_id,failed_attempt_id,lesson_id,policy_revision,reason,owner_actor,lesson_fingerprint)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING expires_at`,[recoveryId,input.botId,input.failedAttemptId,input.lessonId,policy.revision,input.reason,actor.id,fingerprint])).rows[0]!;
      await tx.query('INSERT INTO bot_curriculum(bot_id,lesson_id) VALUES($1,$2)',[input.botId,input.lessonId]);
      await audit(tx,actor,'academy.recovery.approved',recoveryId,{...input,extraAttempts:1,expiresAt:new Date(grant.expires_at).toISOString()});
      return {id:recoveryId,botId:input.botId,extraAttempts:1,expiresAt:new Date(grant.expires_at).toISOString()};
    });
  }
  revoke(actor:Actor,key:string,raw:unknown) {
    permit(actor,'owner');const input=parse(z.object({recoveryId:z.uuid(),reason:text}).strict(),raw);
    return this.db.command(actor,'skill-recovery-revoke',key,input,async tx=>{
      requireThat((await tx.query('SELECT id FROM skill_recoveries WHERE id=$1',[input.recoveryId])).rows.length,'Recovery approval not found',404);
      requireThat(!(await tx.query('SELECT recovery_id FROM skill_recovery_revocations WHERE recovery_id=$1',[input.recoveryId])).rows.length,'Recovery already revoked');
      await tx.query('INSERT INTO skill_recovery_revocations(recovery_id,reason,actor) VALUES($1,$2,$3)',[input.recoveryId,input.reason,actor.id]);
      await audit(tx,actor,'academy.recovery.revoked',input.recoveryId,{reason:input.reason});return {id:input.recoveryId,status:'revoked'};
    });
  }
  status(actor:Actor) {
    permit(actor,'owner','evaluator');return this.db.transaction(async tx=>({
      items:(await tx.query(`SELECT g.*,v.reason AS revocation_reason,u.attempt_id,
        g.expires_at<=clock_timestamp() AS expired FROM skill_recoveries g
        LEFT JOIN skill_recovery_revocations v ON v.recovery_id=g.id
        LEFT JOIN skill_recovery_attempts u ON u.recovery_id=g.id ORDER BY g.created_at DESC,g.id LIMIT 100`)).rows,
      scope:'historical recovery approvals; current support is rechecked before use; no financial authority',
    }));
  }
}
