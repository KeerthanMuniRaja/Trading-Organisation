import { z } from 'zod';
import { Actor, digest, id, parse, permit, requireThat, uuid } from './core.js';
import { audit, Database, Row, Sql } from './database.js';
import { curriculumStatus } from './research-eligibility.js';

export const producerSchema=z.object({name:id,version:id,sourceSha256:z.string().regex(/^[a-f0-9]{64}$/),
  kind:z.enum(['deterministic','model']),modelRef:id.optional()}).strict()
  .refine(p=>p.kind==='model'?Boolean(p.modelRef):p.modelRef===undefined,'Model reference must match producer kind');
export type Producer=z.infer<typeof producerSchema>;
export async function registerSkillProducer(tx:Sql,actor:Actor,producer:Producer) {
  const hash=digest(producer);
  if(!(await tx.query('SELECT hash FROM skill_producers WHERE hash=$1',[hash])).rows.length){
    requireThat(Number((await tx.query('SELECT count(*) AS count FROM skill_producers')).rows[0]!.count)<100,'Producer registry capacity reached');
    await tx.query('INSERT INTO skill_producers(hash,manifest,first_reporter) VALUES($1,$2::jsonb,$3)',[hash,JSON.stringify(producer),actor.id]);
  }
  return hash;
}
export async function bindSkillProducer(tx:Sql,actor:Actor,attemptId:string,producer?:Producer) {
  if(!producer)return;
  const hash=await registerSkillProducer(tx,actor,producer);
  await tx.query('INSERT INTO skill_attempt_producers VALUES($1,$2)',[attemptId,hash]);
}
export async function skillProducer(tx:Sql,attemptId:string) {
  return (await tx.query('SELECT producer_hash FROM skill_attempt_producers WHERE attempt_id=$1',[attemptId])).rows[0]?.producer_hash as string|undefined;
}
const guidance:Record<string,string>={
  costs:'Recalculate net profit after both stated fees and slippage; preserve losses.',
  drawdown:'Track each preceding equity peak and measure the largest decline from that peak.',
  informationTiming:'Require both event time and information availability time to be at or before the cutoff.',
  abstention:'Wait whenever halted, evidence is unverified, or the required research budget is unavailable.',
};
export async function diagnoseSkill(tx:Sql,actor:Actor,attemptId:string,checks:Record<string,boolean>) {
  const failed=Object.keys(guidance).filter(name=>checks[name]===false);
  requireThat(failed.length>0,'A failed check is required for diagnosis');
  const description='Observed failed checks: '+failed.join(', ')+'. This identifies incorrect answers, not an established root cause.';
  await tx.query('INSERT INTO skill_diagnoses(attempt_id,failed_checks,description) VALUES($1,$2::jsonb,$3)',[attemptId,JSON.stringify(failed),description]);
  await audit(tx,actor,'academy.diagnosis.recorded',attemptId,{failedChecks:failed});
}
function correctiveText(attemptId:string,failed:string[]) {
  return `Corrective research-basics plan for graded synthetic exam ${attemptId}. `+
    failed.map(name=>guidance[name]).join(' ')+
    ' Check the implementation on fresh cases. This is a deterministic proposal from observed errors, not proof that a model learned, a root-cause verdict or permission for another attempt.';
}

export class SkillDiagnostics {
  constructor(private readonly db:Database) {}
  cycle(actor:Actor,key:string,raw:unknown) {
    permit(actor,'researcher','evaluator');const input=parse(z.object({}).strict(),raw);
    return this.db.command(actor,'skill-remediation-cycle',key,input,async tx=>{
      const policy=(await tx.query('SELECT enabled,revision FROM skill_policy WHERE id=1')).rows[0]!;
      if(!policy.enabled)return {status:'disabled',actions:[]};
      if((await tx.query('SELECT halted FROM system_lock WHERE id=1')).rows[0]!.halted)return {status:'halted',actions:[]};
      const actions:Record<string,unknown>[]=[];
      if(actor.role==='researcher'){
        const cases=(await tx.query(`SELECT d.*,a.bot_id FROM skill_diagnoses d JOIN skill_attempts a ON a.id=d.attempt_id
          JOIN bots b ON b.id=a.bot_id LEFT JOIN skill_remediation_proposals p ON p.attempt_id=a.id
          WHERE p.id IS NULL AND b.state<>'retired' AND a.policy_revision=$1
          AND EXISTS(SELECT 1 FROM bot_curriculum c WHERE c.bot_id=b.id)
          AND NOT EXISTS(SELECT 1 FROM bot_curriculum c JOIN lessons l ON l.id=c.lesson_id
            JOIN evidence e ON e.id=l.evidence_id JOIN sources s ON s.id=e.source_id
            WHERE c.bot_id=b.id AND (l.status<>'verified' OR e.status<>'verified' OR s.approved=false))
          ORDER BY d.created_at,a.id LIMIT 10`,[policy.revision])).rows;
        for(const c of cases){
          if(!(await curriculumStatus(tx,c.bot_id)).valid)continue;
          const lesson=(await tx.query(`SELECT l.evidence_id FROM bot_curriculum bc JOIN lessons l ON l.id=bc.lesson_id
            WHERE bc.bot_id=$1 ORDER BY l.id LIMIT 1`,[c.bot_id])).rows[0]!;
          const proposalId=uuid(),content=correctiveText(c.attempt_id,c.failed_checks);
          await tx.query(`INSERT INTO skill_remediation_proposals(id,attempt_id,bot_id,evidence_id,content,author)
            VALUES($1,$2,$3,$4,$5,$6)`,[proposalId,c.attempt_id,c.bot_id,lesson.evidence_id,content,actor.id]);
          await audit(tx,actor,'academy.remediation.proposed',proposalId,{attemptId:c.attempt_id,botId:c.bot_id});
          actions.push({proposalId,action:'proposed'});
        }
      }else{
        const proposals=(await tx.query(`SELECT p.*,d.failed_checks,a.policy_revision FROM skill_remediation_proposals p
          JOIN skill_diagnoses d ON d.attempt_id=p.attempt_id JOIN skill_attempts a ON a.id=p.attempt_id
          LEFT JOIN skill_remediation_reviews r ON r.proposal_id=p.id WHERE r.proposal_id IS NULL AND p.author<>$1
          ORDER BY p.created_at,p.id LIMIT 10`,[actor.id])).rows;
        for(const p of proposals){
          const evidence=(await tx.query(`SELECT e.id FROM evidence e JOIN sources s ON s.id=e.source_id
            WHERE e.id=$1 AND e.status='verified' AND s.approved=true`,[p.evidence_id])).rows.length;
          const active=(await tx.query("SELECT id FROM bots WHERE id=$1 AND state<>'retired'",[p.bot_id])).rows.length;
          const valid=Boolean(evidence&&active&&p.policy_revision===policy.revision&&
            (await curriculumStatus(tx,p.bot_id)).valid&&p.content===correctiveText(p.attempt_id,p.failed_checks));
          const lessonId=valid?uuid():null,decision=valid?'verified':'rejected';
          const reason=valid?'Matches the deterministic corrective plan and current supporting curriculum':'Policy, curriculum, evidence or proposal support changed';
          if(lessonId)await tx.query(`INSERT INTO lessons(id,bot_id,content,evidence_id,status,author,reviewer)
            VALUES($1,$2,$3,$4,'verified',$5,$6)`,[lessonId,p.bot_id,p.content,p.evidence_id,p.author,actor.id]);
          await tx.query('INSERT INTO skill_remediation_reviews(proposal_id,decision,reviewer,lesson_id,reason) VALUES($1,$2,$3,$4,$5)',[p.id,decision,actor.id,lessonId,reason]);
          await audit(tx,actor,'academy.remediation.'+decision,p.id,{attemptId:p.attempt_id,lessonId,reason});
          actions.push({proposalId:p.id,action:decision,lessonId});
        }
      }
      return {status:actions.length?'completed':'idle',actions};
    });
  }
  status(actor:Actor) {
    permit(actor,'owner','evaluator');return this.db.transaction(async tx=>({
      cases:(await tx.query(`SELECT d.*,a.bot_id,a.policy_revision,p.producer_hash FROM skill_diagnoses d
        JOIN skill_attempts a ON a.id=d.attempt_id LEFT JOIN skill_attempt_producers p ON p.attempt_id=a.id
        ORDER BY d.created_at DESC,a.id LIMIT 100`)).rows,
      recurring:(await tx.query(`SELECT a.bot_id,p.producer_hash,f.check_name,count(*)::int AS failures
        FROM skill_diagnoses d JOIN skill_attempts a ON a.id=d.attempt_id
        LEFT JOIN skill_attempt_producers p ON p.attempt_id=a.id
        CROSS JOIN LATERAL jsonb_array_elements_text(d.failed_checks) AS f(check_name)
        GROUP BY a.bot_id,p.producer_hash,f.check_name HAVING count(*)>1 ORDER BY failures DESC,a.bot_id LIMIT 100`)).rows,
      proposals:(await tx.query(`SELECT p.*,r.decision,r.reviewer,r.lesson_id,r.reason FROM skill_remediation_proposals p
        LEFT JOIN skill_remediation_reviews r ON r.proposal_id=p.id ORDER BY p.created_at DESC,p.id LIMIT 100`)).rows,
      limitation:'Observed errors and deterministic lesson proposals; no proven cause, automatic repair, recovery approval or model training',
    }));
  }
  versions(actor:Actor) {
    permit(actor,'owner','evaluator');return this.db.transaction(async tx=>({
      producers:(await tx.query('SELECT * FROM skill_producers ORDER BY created_at DESC,hash LIMIT 100')).rows,
      outcomes:await this.outcomes(tx),
      attribution:'Authenticated worker declaration, not execution attestation; missing hashes are unattributed legacy work',
    }));
  }
  private async outcomes(tx:Sql) {
    return (await tx.query(`SELECT p.producer_hash,a.rubric,a.policy_revision,count(*)::int AS attempts,
      count(*) FILTER(WHERE r.outcome='passed')::int AS passed,count(*) FILTER(WHERE r.outcome='failed')::int AS failed,
      count(*) FILTER(WHERE r.outcome='invalidated')::int AS invalidated,
      count(*) FILTER(WHERE r.attempt_id IS NULL AND s.attempt_id IS NOT NULL)::int AS awaiting_review,
      count(*) FILTER(WHERE s.attempt_id IS NULL AND a.expires_at<=clock_timestamp())::int AS expired,
      count(*) FILTER(WHERE s.attempt_id IS NULL AND a.expires_at>clock_timestamp())::int AS outstanding
      FROM skill_attempts a LEFT JOIN skill_attempt_producers p ON p.attempt_id=a.id
      LEFT JOIN skill_submissions s ON s.attempt_id=a.id LEFT JOIN skill_reviews r ON r.attempt_id=a.id
      GROUP BY p.producer_hash,a.rubric,a.policy_revision ORDER BY a.policy_revision,p.producer_hash`)).rows;
  }
  compare(actor:Actor,raw:unknown) {
    permit(actor,'owner','evaluator');const hash=z.string().regex(/^[a-f0-9]{64}$/);
    const input=parse(z.object({baselineHash:hash,candidateHash:hash}).strict(),raw);
    requireThat(input.baselineHash!==input.candidateHash,'Choose two different declared versions',400);
    return this.db.transaction(async tx=>{
      for(const h of [input.baselineHash,input.candidateHash])requireThat((await tx.query('SELECT hash FROM skill_producers WHERE hash=$1',[h])).rows.length,'Declared producer not found',404);
      const rows=await this.outcomes(tx);
      return {baseline:rows.filter(r=>r.producer_hash===input.baselineHash),candidate:rows.filter(r=>r.producer_hash===input.candidateHash),
        promotionAllowed:false,verdict:'descriptive-only',
        limitations:['Different random questions and student cohorts; no paired causal comparison','Declared source fingerprints are not verified execution','No version approval or deployment is performed']};
    });
  }
}
