import { z } from 'zod';
import { Actor, parse, permit, requireThat, text, uuid } from './core.js';
import { audit, Database } from './database.js';
import { skillRubric } from './skill-contract.js';

const hash=z.string().regex(/^[a-f0-9]{64}$/);
const boundaries={scope:'further-research-only',deploymentAllowed:false,tradingAllowed:false,verifiedExecution:false};

export function approveResearch(db:Database,actor:Actor,key:string,raw:unknown){
  permit(actor,'owner');
  const input=parse(z.object({experimentId:z.uuid(),planHash:hash,candidateHash:hash,
    validHours:z.number().int().min(1).max(168),reason:text}).strict(),raw);
  return db.command(actor,'research-approval',key,input,async tx=>{
    const p=(await tx.query(`SELECT p.*,r.outcome,r.reviewer,c.enabled,c.revision,
      (SELECT halted FROM system_lock WHERE id=1) AS halted,
      EXISTS(SELECT 1 FROM skill_experiment_cancellations x WHERE x.experiment_id=p.id) AS cancelled
      FROM skill_experiments p JOIN skill_experiment_reviews r ON r.experiment_id=p.id
      CROSS JOIN skill_policy c WHERE p.id=$1 AND c.id=1`,[input.experimentId])).rows[0];
    requireThat(p&&p.outcome==='meets-criteria','Independently reviewed passing experiment required');
    requireThat(p.reviewer!==actor.id&&p.reviewer!==p.researcher,'Independent review required');
    requireThat(p.enabled&&!p.halted&&!p.cancelled&&p.policy_revision===p.revision&&p.rubric===skillRubric,'Current unhalted policy support required');
    requireThat(p.plan_hash===input.planHash&&p.candidate_hash===input.candidateHash,'Planned candidate identity mismatch');
    requireThat(!(await tx.query('SELECT 1 FROM skill_research_approvals WHERE experiment_id=$1',[p.id])).rows.length,'Experiment already has an approval; obtain a new evaluation');
    const approvalId=uuid();
    const row=(await tx.query(`INSERT INTO skill_research_approvals(id,experiment_id,owner_id,candidate_hash,plan_hash,policy_revision,reason,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+$8*interval '1 hour') RETURNING expires_at`,
      [approvalId,p.id,actor.id,input.candidateHash,input.planHash,p.revision,input.reason,input.validHours])).rows[0]!;
    await audit(tx,actor,'research.candidate.approved',approvalId,{experimentId:p.id,candidateHash:input.candidateHash,expiresAt:row.expires_at,...boundaries});
    return {approvalId,experimentId:p.id,candidateHash:input.candidateHash,expiresAt:new Date(row.expires_at).toISOString(),...boundaries};
  });
}

export function revokeResearch(db:Database,actor:Actor,key:string,raw:unknown){
  permit(actor,'owner');const input=parse(z.object({approvalId:z.uuid(),reason:text}).strict(),raw);
  return db.command(actor,'research-approval-revoke',key,input,async tx=>{
    requireThat((await tx.query('SELECT 1 FROM skill_research_approvals WHERE id=$1',[input.approvalId])).rows.length,'Approval not found',404);
    const old=(await tx.query('SELECT reason FROM skill_research_revocations WHERE approval_id=$1',[input.approvalId])).rows[0];
    if(old)requireThat(old.reason===input.reason,'Revocation reason already fixed');
    else{
      await tx.query('INSERT INTO skill_research_revocations(approval_id,owner_id,reason) VALUES($1,$2,$3)',[input.approvalId,actor.id,input.reason]);
      await audit(tx,actor,'research.candidate.revoked',input.approvalId,{reason:input.reason,...boundaries});
    }
    return {approvalId:input.approvalId,status:'revoked',...boundaries};
  });
}

export function researchApprovals(db:Database,actor:Actor){
  permit(actor,'owner','evaluator');return db.transaction(async tx=>({
    approvals:(await tx.query(`SELECT a.*,v.reason AS revocation_reason,
      CASE WHEN v.approval_id IS NOT NULL THEN 'revoked'
        WHEN a.expires_at<=clock_timestamp() THEN 'expired'
        WHEN NOT c.enabled OR a.policy_revision<>c.revision THEN 'unsupported'
        WHEN l.halted THEN 'halted' ELSE 'approved-for-research' END AS current_state
      FROM skill_research_approvals a LEFT JOIN skill_research_revocations v ON v.approval_id=a.id
      CROSS JOIN skill_policy c CROSS JOIN system_lock l WHERE c.id=1 AND l.id=1
      ORDER BY a.created_at DESC,a.id LIMIT 100`)).rows,
    ...boundaries,limitation:'Governance record only. No worker consumes this as execution authority; approval does not deploy code or attest a runtime.',
  }));
}
