import { z } from 'zod';
import { Actor, digest, parse, permit, requireThat, uuid } from './core.js';
import { audit, Database, Row, Sql } from './database.js';
import { Challenge, gradeSkill, makeChallenge, skillAnswers, skillRubric } from './skill-contract.js';
import { currentSkillRecovery, schoolSkillBudget } from './skill-recovery.js';
import { bindSkillProducer, diagnoseSkill, producerSchema, skillProducer } from './skill-diagnostics.js';

async function curriculum(tx:Sql,botId:string) {
  const rows=(await tx.query(`SELECT l.id,l.status,e.status AS evidence_status,s.approved FROM bot_curriculum c
    JOIN lessons l ON l.id=c.lesson_id JOIN evidence e ON e.id=l.evidence_id JOIN sources s ON s.id=e.source_id
    WHERE c.bot_id=$1 ORDER BY l.id`,[botId])).rows;
  return rows.length&&rows.every(r=>r.status==='verified'&&r.evidence_status==='verified'&&r.approved)?rows.map(r=>r.id as string):null;
}
async function supported(tx:Sql,attempt:Row,revision:number) {
  if(attempt.policy_revision!==revision||attempt.rubric!==skillRubric)return false;
  const recovery=(await tx.query('SELECT recovery_id FROM skill_recovery_attempts WHERE attempt_id=$1',[attempt.id])).rows[0];
  if(recovery&&!await currentSkillRecovery(tx,attempt.bot_id,revision,recovery.recovery_id))return false;
  const bot=(await tx.query("SELECT id FROM bots WHERE id=$1 AND lifecycle_managed=true AND state='school'",[attempt.bot_id])).rows[0];
  const lessons=await curriculum(tx,attempt.bot_id);
  return Boolean(bot&&lessons&&digest(lessons)===digest(attempt.curriculum));
}
export async function schoolSkillReady(tx:Sql,botId:string) {
  const policy=(await tx.query('SELECT * FROM skill_policy WHERE id=1')).rows[0]!;
  if(!policy.enabled)return true;
  const attempts=(await tx.query(`SELECT a.* FROM skill_attempts a JOIN skill_reviews r ON r.attempt_id=a.id
    WHERE a.bot_id=$1 AND a.policy_revision=$2 AND r.outcome='passed'`,[botId,policy.revision])).rows;
  for(const attempt of attempts)if(await supported(tx,attempt,policy.revision))return true;
  return false;
}

export class AcademySkills {
  constructor(private readonly db:Database) {}
  configure(actor:Actor,key:string,raw:unknown) {
    permit(actor,'owner');const input=parse(z.object({expectedRevision:z.number().int().min(0),enabled:z.boolean(),
      maxPerDay:z.number().int().min(1).max(100),maxLifetime:z.number().int().min(1).max(1000)}).strict(),raw);
    return this.db.command(actor,'skills-policy',key,input,async tx=>{
      const current=(await tx.query('SELECT revision FROM skill_policy WHERE id=1')).rows[0]!;
      requireThat(current.revision===input.expectedRevision,'Skill policy revision changed');
      const revision=current.revision+1;
      await tx.query('UPDATE skill_policy SET revision=$1,enabled=$2,max_per_day=$3,max_lifetime=$4 WHERE id=1',[revision,input.enabled,input.maxPerDay,input.maxLifetime]);
      await audit(tx,actor,'academy.skills.policy','research-basics',{...input,revision,rubric:skillRubric});return {revision};
    });
  }
  claim(actor:Actor,key:string,raw:unknown) {
    permit(actor,'researcher');const input=parse(z.object({producer:producerSchema.optional()}).strict(),raw);
    return this.db.command(actor,'skills-claim',key,input,async tx=>{
      const policy=(await tx.query('SELECT * FROM skill_policy WHERE id=1')).rows[0]!;
      if(!policy.enabled)return {status:'disabled',attempt:null};
      if((await tx.query('SELECT halted FROM system_lock WHERE id=1')).rows[0]!.halted)return {status:'halted',attempt:null};
      const bots=(await tx.query("SELECT id FROM bots WHERE lifecycle_managed=true AND state='school' ORDER BY created_at,id LIMIT 100")).rows;
      const receipt=async(a:Row)=>({id:a.id,botId:a.bot_id,rubric:a.rubric,challenge:a.challenge,expiresAt:new Date(a.expires_at).toISOString(),producerHash:await skillProducer(tx,a.id)??null});
      for(const bot of bots){
        const lessons=await curriculum(tx,bot.id);if(!lessons||await schoolSkillReady(tx,bot.id))continue;
        const pending=(await tx.query(`SELECT a.*,s.attempt_id AS submitted FROM skill_attempts a
          LEFT JOIN skill_submissions s ON s.attempt_id=a.id LEFT JOIN skill_reviews r ON r.attempt_id=a.id
          WHERE a.bot_id=$1 AND a.policy_revision=$2 AND r.attempt_id IS NULL
          AND (s.attempt_id IS NOT NULL OR a.expires_at>clock_timestamp()) ORDER BY a.created_at`,[bot.id,policy.revision])).rows[0];
        if(pending){
          if(!pending.submitted&&pending.author===actor.id&&await supported(tx,pending,policy.revision)){
            requireThat(await skillProducer(tx,pending.id)===(input.producer?digest(input.producer):undefined),'Pending attempt is bound to a different producer');
            return {status:'claimed',attempt:await receipt(pending)};
          }
          continue;
        }
        // Failed and expired attempts keep their lifetime cost, including across policy changes.
        const budget=await schoolSkillBudget(tx,bot.id,policy.revision);
        if(!budget.baseRemaining&&!budget.recoveryAvailable)continue;
        const counts=(await tx.query(`SELECT count(*)::int AS total,count(*) FILTER(WHERE created_at>clock_timestamp()-interval '24 hours')::int AS daily FROM skill_attempts`)).rows[0]!;
        if(counts.total>=policy.max_lifetime||counts.daily>=policy.max_per_day)return {status:'capacity',attempt:null};
        const attempt=(await tx.query(`INSERT INTO skill_attempts(id,bot_id,policy_revision,rubric,curriculum,challenge,author)
          VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) RETURNING *`,[uuid(),bot.id,policy.revision,skillRubric,JSON.stringify(lessons),JSON.stringify(makeChallenge()),actor.id])).rows[0]!;
        await bindSkillProducer(tx,actor,attempt.id,input.producer);
        if(budget.recoveryId){
          await tx.query('INSERT INTO skill_recovery_attempts(recovery_id,attempt_id) VALUES($1,$2)',[budget.recoveryId,attempt.id]);
          await audit(tx,actor,'academy.recovery.consumed',budget.recoveryId,{botId:bot.id,attemptId:attempt.id});
        }
        await audit(tx,actor,'academy.skills.claimed',attempt.id,{botId:bot.id,rubric:skillRubric});
        return {status:'claimed',attempt:await receipt(attempt)};
      }
      return {status:'idle',attempt:null};
    });
  }
  submit(actor:Actor,key:string,raw:unknown) {
    permit(actor,'researcher');const input=parse(z.object({attemptId:z.uuid(),answers:skillAnswers,producerHash:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict(),raw);
    return this.db.command(actor,'skills-submit',key,input,async tx=>{
      const policy=(await tx.query('SELECT * FROM skill_policy WHERE id=1')).rows[0]!;
      requireThat(policy.enabled,'Skill assessment disabled');
      requireThat(!(await tx.query('SELECT halted FROM system_lock WHERE id=1')).rows[0]!.halted,'System halted');
      const a=(await tx.query('SELECT *,expires_at>clock_timestamp() AS fresh FROM skill_attempts WHERE id=$1',[input.attemptId])).rows[0];
      requireThat(a&&a.author===actor.id,'Own skill attempt required',403);
      requireThat(await skillProducer(tx,a.id)===input.producerHash,'Submission producer differs from claimed version');
      requireThat(await supported(tx,a,policy.revision),'Skill attempt support or policy changed');
      const old=(await tx.query('SELECT answers FROM skill_submissions WHERE attempt_id=$1',[a.id])).rows[0];
      if(old){requireThat(digest(old.answers)===digest(input.answers),'Answers already fixed');return {id:a.id,state:'submitted'};}
      requireThat(a.fresh,'Skill attempt expired');
      await tx.query('INSERT INTO skill_submissions(attempt_id,answers,author) VALUES($1,$2::jsonb,$3)',[a.id,JSON.stringify(input.answers),actor.id]);
      await audit(tx,actor,'academy.skills.submitted',a.id,{botId:a.bot_id});return {id:a.id,state:'submitted'};
    });
  }
  cycle(actor:Actor,key:string,raw:unknown) {
    permit(actor,'evaluator');const input=parse(z.object({}).strict(),raw);
    return this.db.command(actor,'skills-cycle',key,input,async tx=>{
      const policy=(await tx.query('SELECT * FROM skill_policy WHERE id=1')).rows[0]!;
      if(!policy.enabled)return {status:'disabled',actions:[]};
      if((await tx.query('SELECT halted FROM system_lock WHERE id=1')).rows[0]!.halted)return {status:'halted',actions:[]};
      const pending=(await tx.query(`SELECT a.*,s.answers FROM skill_attempts a JOIN skill_submissions s ON s.attempt_id=a.id
        LEFT JOIN skill_reviews r ON r.attempt_id=a.id WHERE r.attempt_id IS NULL AND a.author<>$1 AND s.author<>$1
        ORDER BY s.created_at,a.id LIMIT 10`,[actor.id])).rows;
      const actions=[];
      for(const a of pending){
        const valid=await supported(tx,a,policy.revision);
        const checks=valid?gradeSkill(a.challenge as Challenge,skillAnswers.parse(a.answers)):{};
        const outcome=!valid?'invalidated':Object.values(checks).every(Boolean)?'passed':'failed';
        await tx.query('INSERT INTO skill_reviews(attempt_id,outcome,checks,reviewer) VALUES($1,$2,$3::jsonb,$4)',[a.id,outcome,JSON.stringify(checks),actor.id]);
        if(outcome==='failed')await diagnoseSkill(tx,actor,a.id,checks);
        await audit(tx,actor,'academy.skills.'+outcome,a.id,{botId:a.bot_id,checks,rubric:skillRubric});
        actions.push({attemptId:a.id,botId:a.bot_id,outcome});
      }
      return {status:actions.length?'completed':'idle',actions};
    });
  }
  status(actor:Actor) {
    permit(actor,'owner','evaluator');return this.db.transaction(async tx=>({
      policy:(await tx.query('SELECT * FROM skill_policy WHERE id=1')).rows[0],rubric:skillRubric,
      attempts:(await tx.query(`SELECT a.id,a.bot_id,a.policy_revision,a.rubric,a.created_at,a.expires_at,
        s.created_at AS submitted_at,r.outcome,r.checks,r.reviewer,p.producer_hash FROM skill_attempts a
        LEFT JOIN skill_attempt_producers p ON p.attempt_id=a.id
        LEFT JOIN skill_submissions s ON s.attempt_id=a.id LEFT JOIN skill_reviews r ON r.attempt_id=a.id
        ORDER BY a.created_at DESC,a.id LIMIT 100`)).rows,
      scope:'synthetic research-basics; no trading permission, reward or model training',
    }));
  }
}
