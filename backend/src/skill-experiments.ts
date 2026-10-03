import { z } from 'zod';
import { Actor, digest, id, parse, permit, requireThat, text, uuid } from './core.js';
import { audit, Database, Row, Sql } from './database.js';
import { Challenge, gradeSkill, makeChallenge, skillAnswers, skillRubric } from './skill-contract.js';
import { producerSchema, registerSkillProducer } from './skill-diagnostics.js';
import { executionStatus, recordExecution } from './execution-reports.js';
import { approveResearch, revokeResearch, researchApprovals } from './research-approvals.js';

const hash=z.string().regex(/^[a-f0-9]{64}$/);
const reference=z.object({experimentId:z.uuid()}).strict();
const pairIdentity={experimentId:z.uuid(),baselineHash:hash,candidateHash:hash};
const criteriaSchema=z.object({minCandidatePassBps:z.number().int().min(0).max(10000),
  maxRegressions:z.number().int().min(0).max(128),minImprovements:z.number().int().min(0).max(128)}).strict();
type Case={id:string;challenge:Challenge};
const checks=['costs','drawdown','informationTiming','abstention'] as const;
async function controls(tx:Sql):Promise<Row>{
  const p=(await tx.query('SELECT * FROM skill_policy WHERE id=1')).rows[0]!;
  const halted=(await tx.query('SELECT halted FROM system_lock WHERE id=1')).rows[0]!.halted;
  return {...p,halted};
}
async function load(tx:Sql,experimentId:string){
  const p=(await tx.query(`SELECT p.*,p.expires_at>clock_timestamp() AS fresh,
    s.experiment_id IS NOT NULL AS submitted,r.outcome,c.experiment_id IS NOT NULL AS cancelled
    FROM skill_experiments p LEFT JOIN skill_experiment_submissions s ON s.experiment_id=p.id
    LEFT JOIN skill_experiment_reviews r ON r.experiment_id=p.id
    LEFT JOIN skill_experiment_cancellations c ON c.experiment_id=p.id WHERE p.id=$1`,[experimentId])).rows[0];
  requireThat(p,'Skill experiment not found',404);return p;
}
function supported(p:Row,c:Row){return c.enabled&&p.policy_revision===c.revision&&p.rubric===skillRubric;}
function open(p:Row,c:Row){
  requireThat(!c.halted,'System halted');requireThat(supported(p,c),'Experiment policy support changed');
  requireThat(!p.cancelled&&!p.outcome,'Experiment already closed');requireThat(p.fresh,'Experiment expired');
}
// Generated only after the owner fixes versions and criteria. Every block covers all control reasons.
function cases(count:number):Case[]{
  return Array.from({length:count},(_,i)=>{
    const challenge=makeChallenge();
    challenge.control=[{halted:false,evidenceVerified:true,budget:10,required:10},
      {halted:true,evidenceVerified:true,budget:10,required:10},
      {halted:false,evidenceVerified:false,budget:10,required:10},
      {halted:false,evidenceVerified:true,budget:9,required:10}][i%4]!;
    return {id:uuid(),challenge};
  });
}
export class SkillExperiments {
  constructor(private readonly db:Database){}
  approveResearch(actor:Actor,key:string,raw:unknown){return approveResearch(this.db,actor,key,raw);}
  revokeResearch(actor:Actor,key:string,raw:unknown){return revokeResearch(this.db,actor,key,raw);}
  researchApprovals(actor:Actor){return researchApprovals(this.db,actor);}
  reportExecution(actor:Actor,key:string,raw:unknown){return recordExecution(this.db,actor,key,raw);}
  executionStatus(actor:Actor){return executionStatus(this.db,actor);}
  register(actor:Actor,key:string,raw:unknown){
    permit(actor,'owner');const input=parse(z.object({baseline:producerSchema,candidate:producerSchema,researcherId:id,
      caseCount:z.number().int().min(8).max(32).refine(n=>n%4===0),criteria:criteriaSchema,purpose:text}).strict(),raw);
    requireThat(input.researcherId!==actor.id,'Separate researcher identity required',400);
    requireThat(digest(input.baseline)!==digest(input.candidate),'Different producer manifests required',400);
    requireThat(input.criteria.minImprovements<=input.caseCount*4&&input.criteria.maxRegressions<=input.caseCount*4,'Criteria exceed check count',400);
    return this.db.command(actor,'skill-experiment-register',key,input,async tx=>{
      const c=await controls(tx);requireThat(c.enabled&&!c.halted,'Enabled skill policy and unhalted system required');
      const counts=(await tx.query(`SELECT count(*)::int AS total,
        count(*) FILTER(WHERE p.created_at>clock_timestamp()-interval '24 hours')::int AS daily,
        count(*) FILTER(WHERE p.expires_at>clock_timestamp() AND r.experiment_id IS NULL AND x.experiment_id IS NULL)::int AS active
        FROM skill_experiments p LEFT JOIN skill_experiment_reviews r ON r.experiment_id=p.id
        LEFT JOIN skill_experiment_cancellations x ON x.experiment_id=p.id`)).rows[0]!;
      requireThat(counts.total<100&&counts.daily<10&&counts.active<3,'Paired experiment capacity reached');
      const baselineHash=await registerSkillProducer(tx,actor,input.baseline),candidateHash=await registerSkillProducer(tx,actor,input.candidate);
      const experimentId=uuid(),questions=cases(input.caseCount);
      const planHash=digest({experimentId,baselineHash,candidateHash,researcherId:input.researcherId,
        policyRevision:c.revision,rubric:skillRubric,criteria:input.criteria,purpose:input.purpose,cases:questions});
      await tx.query(`INSERT INTO skill_experiments(id,author,researcher,baseline_hash,candidate_hash,policy_revision,rubric,criteria,cases,plan_hash,purpose)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11)`,
        [experimentId,actor.id,input.researcherId,baselineHash,candidateHash,c.revision,skillRubric,JSON.stringify(input.criteria),JSON.stringify(questions),planHash,input.purpose]);
      await audit(tx,actor,'academy.experiment.registered',experimentId,{planHash,baselineHash,candidateHash,caseCount:questions.length,criteria:input.criteria});
      return {experimentId,planHash,baselineHash,candidateHash,promotionAllowed:false};
    });
  }
  work(actor:Actor,raw:unknown){
    permit(actor,'researcher');const input=parse(z.object(pairIdentity).strict(),raw);
    return this.db.transaction(async tx=>{
      const p=await load(tx,input.experimentId);requireThat(p.researcher===actor.id,'Assigned researcher required',403);
      open(p,await controls(tx));requireThat(!p.submitted,'Paired answers already submitted');
      requireThat(p.baseline_hash===input.baselineHash&&p.candidate_hash===input.candidateHash,'Planned producer mismatch');
      return {experimentId:p.id,planHash:p.plan_hash,baselineHash:p.baseline_hash,candidateHash:p.candidate_hash,
        rubric:p.rubric,criteria:p.criteria,cases:p.cases,expiresAt:new Date(p.expires_at).toISOString()};
    });
  }
  submit(actor:Actor,key:string,raw:unknown){
    permit(actor,'researcher');const input=parse(z.object({...pairIdentity,planHash:hash,
      results:z.array(z.object({caseId:z.uuid(),baseline:skillAnswers,candidate:skillAnswers}).strict()).min(8).max(32)}).strict(),raw);
    return this.db.command(actor,'skill-experiment-submit',key,input,async tx=>{
      const p=await load(tx,input.experimentId);requireThat(p.researcher===actor.id,'Assigned researcher required',403);
      open(p,await controls(tx));
      requireThat(p.plan_hash===input.planHash&&p.baseline_hash===input.baselineHash&&p.candidate_hash===input.candidateHash,'Planned producer or plan mismatch');
      const expected=(p.cases as Case[]).map(c=>c.id).sort(),actual=input.results.map(r=>r.caseId).sort();
      requireThat(digest(expected)===digest(actual),'Submit every planned case exactly once');
      const old=(await tx.query('SELECT payload FROM skill_experiment_submissions WHERE experiment_id=$1',[p.id])).rows[0];
      if(old){requireThat(digest(old.payload)===digest(input),'Paired answers already fixed');return {experimentId:p.id,status:'submitted'};}
      await tx.query('INSERT INTO skill_experiment_submissions(experiment_id,author,payload) VALUES($1,$2,$3::jsonb)',[p.id,actor.id,JSON.stringify(input)]);
      await audit(tx,actor,'academy.experiment.submitted',p.id,{planHash:p.plan_hash,cases:expected.length});
      return {experimentId:p.id,status:'submitted'};
    });
  }
  review(actor:Actor,key:string,raw:unknown){
    permit(actor,'evaluator');const input=parse(reference,raw);
    return this.db.command(actor,'skill-experiment-review',key,input,async tx=>{
      const p=await load(tx,input.experimentId);
      requireThat(actor.id!==p.researcher&&actor.id!==p.author,'Independent evaluator required',403);
      const old=(await tx.query('SELECT report FROM skill_experiment_reviews WHERE experiment_id=$1',[p.id])).rows[0];
      if(old)return old.report;
      const c=await controls(tx);requireThat(!c.halted,'System halted');requireThat(!p.cancelled,'Experiment cancelled');
      const s=(await tx.query('SELECT payload FROM skill_experiment_submissions WHERE experiment_id=$1',[p.id])).rows[0];
      requireThat(s,'Complete paired submission required');
      let report:Record<string,unknown>;
      if(!supported(p,c))report={outcome:'invalidated',reason:'Policy or rubric support changed',promotionAllowed:false};
      else{
        const results=s.payload.results as {caseId:string;baseline:z.infer<typeof skillAnswers>;candidate:z.infer<typeof skillAnswers>}[];
        const rows=(p.cases as Case[]).map(q=>{
          const r=results.find(v=>v.caseId===q.id)!;
          return {caseId:q.id,baseline:gradeSkill(q.challenge,r.baseline),candidate:gradeSkill(q.challenge,r.candidate)};
        });
        const totals={baselinePassed:0,candidatePassed:0,improvements:0,regressions:0,totalChecks:rows.length*4};
        const bySkill=Object.fromEntries(checks.map(check=>[check,{baselinePassed:0,candidatePassed:0,improvements:0,regressions:0}]));
        for(const row of rows)for(const check of checks){
          const b=row.baseline[check],n=row.candidate[check],t=bySkill[check]!;
          for(const bucket of [totals,t]){bucket.baselinePassed+=Number(b);bucket.candidatePassed+=Number(n);bucket.improvements+=Number(!b&&n);bucket.regressions+=Number(b&&!n);}
        }
        const criteria=p.criteria as z.infer<typeof criteriaSchema>;
        const meets=totals.candidatePassed*10000>=criteria.minCandidatePassBps*totals.totalChecks&&
          totals.regressions<=criteria.maxRegressions&&totals.improvements>=criteria.minImprovements;
        report={outcome:meets?'meets-criteria':'below-criteria',planHash:p.plan_hash,totals,bySkill,cases:rows,
          promotionAllowed:false,limitations:['Synthetic research-basics only; no profitability or statistical significance claim',
            'Producer declarations are not verified execution; same researcher submits both arms','No release, curriculum, reputation or financial authority change']};
      }
      await tx.query('INSERT INTO skill_experiment_reviews(experiment_id,reviewer,outcome,report) VALUES($1,$2,$3,$4::jsonb)',[p.id,actor.id,report.outcome,JSON.stringify(report)]);
      await audit(tx,actor,'academy.experiment.reviewed',p.id,{outcome:report.outcome,planHash:p.plan_hash,promotionAllowed:false});return report;
    });
  }
  cancel(actor:Actor,key:string,raw:unknown){
    permit(actor,'owner');const input=parse(z.object({experimentId:z.uuid(),reason:text}).strict(),raw);
    return this.db.command(actor,'skill-experiment-cancel',key,input,async tx=>{
      const p=await load(tx,input.experimentId);requireThat(!p.outcome,'Reviewed experiment cannot be cancelled');
      if(!p.cancelled){await tx.query('INSERT INTO skill_experiment_cancellations(experiment_id,author,reason) VALUES($1,$2,$3)',[p.id,actor.id,input.reason]);
        await audit(tx,actor,'academy.experiment.cancelled',p.id,{reason:input.reason});}
      return {experimentId:p.id,status:'cancelled'};
    });
  }
  status(actor:Actor){
    permit(actor,'owner','evaluator');return this.db.transaction(async tx=>{
      const c=await controls(tx);
      const rows=(await tx.query(`SELECT p.id,p.author,p.researcher,p.baseline_hash,p.candidate_hash,p.policy_revision,p.rubric,
        p.criteria,p.plan_hash,p.purpose,p.created_at,p.expires_at,jsonb_array_length(p.cases) AS case_count,
        p.expires_at>clock_timestamp() AS fresh,s.experiment_id IS NOT NULL AS submitted,r.outcome,r.report,
        x.experiment_id IS NOT NULL AS cancelled,x.reason AS cancellation_reason
        FROM skill_experiments p LEFT JOIN skill_experiment_submissions s ON s.experiment_id=p.id
        LEFT JOIN skill_experiment_reviews r ON r.experiment_id=p.id LEFT JOIN skill_experiment_cancellations x ON x.experiment_id=p.id
        ORDER BY p.created_at DESC,p.id LIMIT 100`)).rows;
      return {experiments:rows.map((p):Row=>({...p,currentSupport:Boolean(supported(p,c)),
        state:p.cancelled?'cancelled':p.outcome??(!supported(p,c)?'unsupported':p.submitted?'awaiting-review':p.fresh?'awaiting-submission':'expired')})),
        halted:c.halted,promotionAllowed:false,limits:{maxActive:3,maxPerDay:10,maxLifetime:100,maxCases:32}};
    });
  }
}
