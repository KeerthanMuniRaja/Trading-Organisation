import { z } from 'zod';
import { HttpException } from '@nestjs/common';
import { Actor, digest, id, parse, permit, requireThat, text, uuid } from './core.js';
import { Database, Row, Sql, audit } from './database.js';
import { sharedResearchMemory, reflectTrial } from './learning-contract.js';
import { verifiedEvidence } from './organisation.js';
import { availableResearchDatasets, curriculumStatus } from './research-eligibility.js';

const thresholds=z.object({minMeanRewardBps:z.number().finite().min(0).max(10000),
  maxDrawdownBps:z.number().finite().gt(0).max(10000),minPositiveWindows:z.number().int().min(1).max(12)}).strict();

async function proposalSupport(tx:Sql,requestId:string) {
  const row=(await tx.query(`SELECT q.author,q.context,p.proposal,r.decision FROM development_requests q
    JOIN development_proposals p ON p.request_id=q.id JOIN development_reviews r ON r.request_id=q.id
    WHERE q.id=$1`,[requestId])).rows[0];
  requireThat(row?.decision==='recommended','A recommended R&D proposal is required');
  const target=(await tx.query('SELECT evidence_id FROM portfolio_datasets WHERE id=$1',[row.context.datasetId])).rows[0]!;
  await verifiedEvidence(tx,target.evidence_id);
  const memory=await sharedResearchMemory(tx,row.proposal.method,undefined,row.context.beforeTrainingEnd);
  requireThat(row.proposal.memoryIds.every((memoryId:string)=>memory.some(m=>m.id===memoryId)),'Experiment supporting memory is unavailable');
  return row;
}

async function windows(tx:Sql,experiment:Row) {
  return (await tx.query(`SELECT d.id,d.digest AS dataset_digest,d.holdout,e.status AS evidence_status,s.approved AS source_approved,
    a.state AS assignment_state,a.created_at AS assigned_at,t.id AS trial_id,t.state,t.author,t.reviewer,t.report,t.method,t.created_at AS submitted_at
    FROM development_experiment_windows w JOIN portfolio_datasets d ON d.id=w.dataset_id
    JOIN evidence e ON e.id=d.evidence_id JOIN sources s ON s.id=e.source_id
    LEFT JOIN research_assignments a ON a.dataset_id=d.id AND a.bot_id=$2
    LEFT JOIN portfolio_trials t ON t.id=a.trial_id
    WHERE w.experiment_id=$1 ORDER BY d.holdout->0->>'timestamp',d.id`,[experiment.id,experiment.bot_id])).rows;
}

export class DevelopmentExperiments {
  constructor(private readonly db:Database) {}

  register(actor:Actor,key:string,raw:unknown) {
    permit(actor,'owner');const input=parse(z.object({requestId:z.uuid(),botId:id,operationalDefinition:text,
      datasetIds:z.array(z.uuid()).min(3).max(12).refine(v=>new Set(v).size===v.length,'Duplicate experiment window'),thresholds}).strict(),raw);
    requireThat(input.thresholds.minPositiveWindows<=input.datasetIds.length,'Positive-window threshold exceeds plan size',400);
    return this.db.command(actor,'development-experiment',key,input,async tx=>{
      requireThat(!(await tx.query('SELECT halted FROM system_lock WHERE id=1')).rows[0]!.halted,'System is halted');
      requireThat((await tx.query('SELECT count(*)::int AS count FROM development_experiments')).rows[0]!.count<100,'Experiment lifetime capacity reached');
      const support=await proposalSupport(tx,input.requestId);
      const bot=(await tx.query(`SELECT b.method FROM bots b JOIN bot_lifecycle l ON l.bot_id=b.id
        WHERE b.id=$1 AND b.lifecycle_managed=true AND b.state='college' AND l.retirement_pending=false`,[input.botId])).rows[0];
      requireThat(bot&&bot.method===support.proposal.method,'An active managed college bot with the proposed method is required');
      requireThat((await curriculumStatus(tx,input.botId)).valid,'Current verified curriculum required');
      requireThat(!(await tx.query(`SELECT x.id FROM development_experiments x WHERE x.bot_id=$1
        AND NOT EXISTS(SELECT 1 FROM development_experiment_results r WHERE r.experiment_id=x.id)
        AND NOT EXISTS(SELECT 1 FROM development_experiment_cancellations c WHERE c.experiment_id=x.id)`,[input.botId])).rows.length,'Bot already has an active experiment');
      const pool=(await tx.query('SELECT rules FROM research_dispatch_policy WHERE id=1')).rows[0]!.rules.datasetIds as string[];
      requireThat(input.datasetIds.every(datasetId=>pool.includes(datasetId)),'Experiment datasets must be in the owner-approved dispatch pool');
      requireThat((await availableResearchDatasets(tx,input.botId,input.datasetIds)).length===input.datasetIds.length,'Experiment requires unused eligible windows');
      const datasets=(await tx.query(`SELECT id,training,holdout FROM portfolio_datasets WHERE id=ANY($1::uuid[]) ORDER BY holdout->0->>'timestamp',id`,[input.datasetIds])).rows;
      let lastEnd='';
      for(const dataset of datasets){
        const start=dataset.holdout[0].timestamp as string,end=dataset.holdout.at(-1).timestamp as string;
        requireThat(start>lastEnd,'Experiment holdout windows must not overlap');lastEnd=end;
        requireThat(Date.parse(dataset.training.at(-1).timestamp)>=Date.parse(support.context.beforeTrainingEnd),'Experiment training cutoff predates the proposal context');
        // All prior assigned/submitted work and every registered R&D window consume periods,
        // including cancelled experiments. Renaming data or a proposal cannot reset history.
        const used=(await tx.query(`SELECT d.id FROM portfolio_datasets d WHERE
          (EXISTS(SELECT 1 FROM research_assignments a WHERE a.dataset_id=d.id)
           OR EXISTS(SELECT 1 FROM portfolio_trials t WHERE t.dataset_id=d.id)
           OR EXISTS(SELECT 1 FROM development_experiment_windows w WHERE w.dataset_id=d.id))
          AND (d.holdout->0->>'timestamp')<=$2 AND (d.holdout-> -1->>'timestamp')>=$1 LIMIT 1`,[start,end])).rows;
        requireThat(!used.length,'Experiment period was already assigned, tested or registered');
      }
      const experimentId=uuid();
      await tx.query(`INSERT INTO development_experiments(id,request_id,bot_id,method,operational_definition,thresholds,approved_by)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`,[experimentId,input.requestId,input.botId,bot.method,input.operationalDefinition,JSON.stringify(input.thresholds),actor.id]);
      for(const datasetId of input.datasetIds)await tx.query('INSERT INTO development_experiment_windows(experiment_id,dataset_id) VALUES($1,$2)',[experimentId,datasetId]);
      await audit(tx,actor,'development.experiment.registered',experimentId,{...input,method:bot.method,scope:'example-method-diagnostics'});
      return {id:experimentId,state:'registered',recruitmentAllowed:false};
    });
  }

  cycle(actor:Actor,key:string,raw:unknown) {
    permit(actor,'evaluator');const input=parse(z.object({}).strict(),raw);
    return this.db.command(actor,'development-experiment-cycle',key,input,async tx=>{
      if((await tx.query('SELECT halted FROM system_lock WHERE id=1')).rows[0]!.halted)return {status:'halted',actions:[]};
      const plans=(await tx.query(`SELECT x.*,q.author AS proposal_author FROM development_experiments x
        JOIN development_requests q ON q.id=x.request_id
        WHERE NOT EXISTS(SELECT 1 FROM development_experiment_results r WHERE r.experiment_id=x.id)
        AND NOT EXISTS(SELECT 1 FROM development_experiment_cancellations c WHERE c.experiment_id=x.id)
        ORDER BY x.created_at,x.id LIMIT 100`)).rows;
      const actions:Record<string,unknown>[]=[];
      for(const plan of plans){
        const data=await windows(tx,plan);
        if(plan.proposal_author===actor.id||plan.approved_by===actor.id||data.some(w=>w.author===actor.id)){
          actions.push({id:plan.id,status:'independent-evaluator-required'});continue;
        }
        let valid=true;
        try{await proposalSupport(tx,plan.request_id);}catch(error){
          // Business validation failures block the plan; infrastructure errors must propagate.
          if(!(error instanceof HttpException)||error.getStatus()>=500)throw error;
          valid=false;
        }
        if(!valid||data.some(w=>w.evidence_status!=='verified'||!w.source_approved)){
          actions.push({id:plan.id,status:'support-withdrawn'});continue;
        }
        if(data.length<3||data.some(w=>w.state!=='evaluated')){
          actions.push({id:plan.id,status:data.some(w=>['failed','cancelled'].includes(w.assignment_state)||w.state==='cancelled')?'incomplete-work':'awaiting-results'});continue;
        }
        requireThat(new Set(data.map(w=>w.id)).size===data.length,'Ambiguous experiment assignments');
        for(const window of data){
          requireThat(new Date(window.assigned_at).getTime()>=new Date(plan.created_at).getTime()
            &&new Date(window.submitted_at).getTime()>=new Date(plan.created_at).getTime(),'Experiment result predates registration');
          requireThat(window.method===plan.method&&window.reviewer&&window.reviewer!==window.author,'Independent method evaluation required');
          reflectTrial({...window,id:window.trial_id});
          requireThat(Number.isFinite(window.report.maxDrawdownBps),'Invalid experiment drawdown');
        }
        const meanRewardBps=data.reduce((sum,w)=>sum+w.report.rewardBps,0)/data.length;
        const maxDrawdownBps=Math.max(...data.map(w=>w.report.maxDrawdownBps));
        const positiveWindows=data.filter(w=>w.report.rewardBps>0).length;
        const supported=meanRewardBps>=plan.thresholds.minMeanRewardBps&&maxDrawdownBps<=plan.thresholds.maxDrawdownBps&&positiveWindows>=plan.thresholds.minPositiveWindows;
        const outcome=supported?'supported-for-further-research':'not-supported';
        const report={policy:'development-example-v1',scope:'example-method-diagnostics',windowCount:data.length,meanRewardBps,maxDrawdownBps,positiveWindows,
          thresholds:plan.thresholds,results:data.map(w=>({datasetId:w.id,trialId:w.trial_id,reportHash:digest(w.report)})),
          recruitmentAllowed:false,tradingAllowed:false,newFitnessReward:false};
        await tx.query('INSERT INTO development_experiment_results(experiment_id,outcome,report,reviewer) VALUES($1,$2,$3::jsonb,$4)',[plan.id,outcome,JSON.stringify(report),actor.id]);
        await audit(tx,actor,'development.experiment.assessed',plan.id,{outcome,report});actions.push({id:plan.id,status:'assessed',outcome});
      }
      return {status:plans.length?'completed':'idle',actions};
    });
  }

  cancel(actor:Actor,key:string,raw:unknown) {
    permit(actor,'owner');const input=parse(z.object({experimentId:z.uuid(),reason:text}).strict(),raw);
    return this.db.command(actor,'development-experiment-cancel',key,input,async tx=>{
      requireThat((await tx.query(`SELECT id FROM development_experiments x WHERE id=$1
        AND NOT EXISTS(SELECT 1 FROM development_experiment_results r WHERE r.experiment_id=x.id)`,[input.experimentId])).rows.length,'An unassessed experiment is required');
      await tx.query('INSERT INTO development_experiment_cancellations(experiment_id,reason,actor) VALUES($1,$2,$3)',[input.experimentId,input.reason,actor.id]);
      await audit(tx,actor,'development.experiment.cancelled',input.experimentId,{reason:input.reason});
      return {id:input.experimentId,state:'cancelled'};
    });
  }

  status(actor:Actor) {
    permit(actor,'owner','evaluator');return this.db.transaction(async tx=>{
      const plans=(await tx.query(`SELECT x.*,r.outcome,r.report,r.reviewer,c.reason AS cancellation_reason FROM development_experiments x
        LEFT JOIN development_experiment_results r ON r.experiment_id=x.id
        LEFT JOIN development_experiment_cancellations c ON c.experiment_id=x.id ORDER BY x.created_at DESC,x.id LIMIT 100`)).rows;
      const items:(Row & {supportCurrent:boolean})[]=[];
      for(const plan of plans){
        let supportCurrent=true;
        try{await proposalSupport(tx,plan.request_id);}catch(error){if(!(error instanceof HttpException)||error.getStatus()>=500)throw error;supportCurrent=false;}
        const data=await windows(tx,plan);
        supportCurrent=supportCurrent&&data.every(w=>w.evidence_status==='verified'&&w.source_approved);
        items.push({...plan,supportCurrent,windows:data.map(w=>({datasetId:w.id,trialId:w.trial_id??null,state:w.state??w.assignment_state??'unassigned'}))});
      }
      return {items,scope:'example-method-diagnostics',automaticRecruitment:false};
    });
  }
}
