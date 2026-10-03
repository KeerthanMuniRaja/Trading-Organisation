import { z } from 'zod';
import { Actor, digest, id, parse, permit, requireThat, symbol, text, timestamp, uuid } from './core.js';
import { Database, audit } from './database.js';
import { verifiedEvidence } from './organisation.js';
import { curriculumStatus } from './research-eligibility.js';

// Research returns are dimensionless floating-point observations, never ledger money.
const row=z.object({timestamp,returns:z.array(z.number().finite().gt(-1).max(1)).min(4).max(20)}).strict();
const rows=(min:number,max:number)=>z.array(row).min(min).max(max).refine(v=>v.every((r,i)=>i===0||Date.parse(r.timestamp)>Date.parse(v[i-1]!.timestamp)),'Rows must be chronological');
const hash=z.string().regex(/^[a-f0-9]{64}$/);
export const portfolioMethod=z.enum(['equal_weight','inverse_volatility','minimum_variance']);
const COST_BPS=15;
const WEIGHT_CAP=0.25;
type ReturnRow=z.infer<typeof row>;

export function portfolioScore(weights:number[],data:ReturnRow[]) {
  const quantities=weights.slice();
  const cost=COST_BPS/10000;
  let peak=1,equity=1-cost,drawdown=cost;
  for(const bar of data){
    for(let i=0;i<quantities.length;i++) quantities[i]=quantities[i]!*(1+bar.returns[i]!);
    equity=quantities.reduce((a,b)=>a+b,0)*(1-cost);
    peak=Math.max(peak,equity);drawdown=Math.max(drawdown,1-equity/peak);
  }
  equity*=1-cost;drawdown=Math.max(drawdown,1-equity/peak);
  requireThat(Number.isFinite(equity)&&Number.isFinite(drawdown),'Non-finite portfolio result',400);
  return {netReturnBps:(equity-1)*10000,maxDrawdownBps:drawdown*10000};
}

export class PortfolioResearch {
  constructor(private readonly db:Database) {}

  dataset(actor:Actor,key:string,raw:unknown) {
    permit(actor,'owner');
    const input=parse(z.object({evidenceId:z.uuid(),purpose:z.literal('example-testing'),
      assets:z.array(symbol).min(4).max(20).refine(a=>new Set(a).size===a.length,'Duplicate asset'),
      training:rows(60,504),holdout:rows(20,126)}).strict(),raw);
    requireThat([...input.training,...input.holdout].every(r=>r.returns.length===input.assets.length),'Asset dimensions differ',400);
    requireThat(Date.parse(input.training.at(-1)!.timestamp)<Date.parse(input.holdout[0]!.timestamp),'Training must precede holdout',400);
    requireThat(Date.parse(input.holdout.at(-1)!.timestamp)<=Date.now(),'Future observations are not allowed',400);
    // Canonical column order makes asset-reordering unable to bypass exact-data deduplication.
    const order=input.assets.map((asset,index)=>({asset,index})).sort((a,b)=>a.asset.localeCompare(b.asset,'en'));
    const assets=order.map(a=>a.asset);
    const reorder=(data:ReturnRow[])=>data.map(r=>({timestamp:new Date(r.timestamp).toISOString(),returns:order.map(a=>r.returns[a.index]!)}));
    const training=reorder(input.training),holdout=reorder(input.holdout);
    const datasetDigest=digest({purpose:input.purpose,assets,training,holdout});
    const holdoutDigest=digest({assets,holdout});
    return this.db.command(actor,'portfolio-dataset',key,input,async tx=>{
      const evidence=await verifiedEvidence(tx,input.evidenceId);
      requireThat(evidence.kind==='dataset','Dataset evidence required',400);
      requireThat(!(await tx.query('SELECT id FROM portfolio_datasets WHERE digest=$1',[datasetDigest])).rows.length,'These exact portfolio observations are already registered');
      const datasetId=uuid();
      await tx.query('INSERT INTO portfolio_datasets(id,evidence_id,purpose,assets,training,holdout,digest,holdout_digest) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8)',[datasetId,input.evidenceId,input.purpose,JSON.stringify(assets),JSON.stringify(training),JSON.stringify(holdout),datasetDigest,holdoutDigest]);
      await audit(tx,actor,'portfolio.dataset.registered',datasetId,{evidenceId:input.evidenceId,digest:datasetDigest,purpose:input.purpose});
      return {id:datasetId,digest:datasetDigest,purpose:input.purpose};
    });
  }

  training(actor:Actor,raw:unknown) {
    permit(actor,'researcher');const input=parse(z.object({datasetId:z.uuid()}).strict(),raw);
    return this.db.transaction(async tx=>{
      const dataset=(await tx.query('SELECT * FROM portfolio_datasets WHERE id=$1',[input.datasetId])).rows[0];
      requireThat(dataset,'Portfolio dataset not found',404);await verifiedEvidence(tx,dataset.evidence_id);
      return {datasetId:dataset.id,datasetDigest:dataset.digest,assets:dataset.assets,training:dataset.training,
        purpose:dataset.purpose,costBps:COST_BPS,weightCap:WEIGHT_CAP,methods:portfolioMethod.options};
    });
  }

  submit(actor:Actor,key:string,raw:unknown) {
    permit(actor,'researcher');const input=parse(z.object({botId:id,datasetId:z.uuid(),datasetDigest:hash,
      method:portfolioMethod,weights:z.array(z.number().finite().min(0).max(WEIGHT_CAP+1e-7)).min(4).max(20),
      assignment:z.object({id:z.uuid(),leaseToken:z.uuid()}).strict().optional()}).strict(),raw);
    requireThat(Math.abs(input.weights.reduce((a,b)=>a+b,0)-1)<=1e-6,'Weights must sum to one',400);
    return this.db.command(actor,'portfolio-submit',key,input,async tx=>{
      requireThat((await tx.query("SELECT id FROM bots WHERE id=$1 AND state='college'",[input.botId])).rows.length,'A college candidate is required');
      const managed=(await tx.query('SELECT l.retirement_pending,b.method FROM bot_lifecycle l JOIN bots b ON b.id=l.bot_id WHERE l.bot_id=$1',[input.botId])).rows[0];
      if(managed){
        requireThat(!managed.retirement_pending,'Student is closing work for retirement');
        requireThat(managed.method===input.method,'Managed student must use its approved method',403);
        requireThat(input.assignment,'Managed students require an approved research assignment',403);
      }
      if(input.assignment){
        const assignment=(await tx.query(`SELECT * FROM research_assignments WHERE id=$1 AND state='running'
          AND lease_owner=$2 AND lease_token=$3 AND lease_until>now()`,[input.assignment.id,actor.id,input.assignment.leaseToken])).rows[0];
        requireThat(assignment,'Assignment lease is no longer valid');
        requireThat(assignment.bot_id===input.botId&&assignment.dataset_id===input.datasetId&&assignment.method===input.method,'Assignment contract mismatch',403);
        const dispatch=(await tx.query('SELECT rules FROM research_dispatch_policy WHERE id=1')).rows[0]!;
        const life=(await tx.query('SELECT rules FROM lifecycle_policy WHERE id=1')).rows[0]!;
        requireThat(dispatch.rules.enabled&&life.rules.enabled&&dispatch.rules.datasetIds.includes(input.datasetId),'Research dispatch is paused or dataset approval withdrawn');
        requireThat(!(await tx.query('SELECT halted FROM system_lock WHERE id=1')).rows[0]!.halted,'System is halted');
        requireThat((await curriculumStatus(tx,input.botId)).valid,'A current verified curriculum is required');
      }
      const dataset=(await tx.query('SELECT * FROM portfolio_datasets WHERE id=$1',[input.datasetId])).rows[0];
      requireThat(dataset,'Portfolio dataset not found',404);await verifiedEvidence(tx,dataset.evidence_id);
      requireThat(dataset.digest===input.datasetDigest&&input.weights.length===dataset.assets.length,'Portfolio dataset contract mismatch',400);
      requireThat(!(await tx.query('SELECT id FROM portfolio_trials WHERE bot_id=$1 AND holdout_digest=$2 AND method=$3',[input.botId,dataset.holdout_digest,input.method])).rows.length,'Method already submitted for this bot and exact holdout');
      const total=input.weights.reduce((a,b)=>a+b,0),weights=input.weights.map(w=>w/total),trialId=uuid();
      requireThat(weights.every(w=>w<=WEIGHT_CAP+1e-7),'Normalised allocation exceeds weight cap',400);
      await tx.query("INSERT INTO portfolio_trials(id,dataset_id,bot_id,holdout_digest,method,weights,author,state) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,'submitted')",[trialId,dataset.id,input.botId,dataset.holdout_digest,input.method,JSON.stringify(weights),actor.id]);
      if(input.assignment){
        await tx.query("UPDATE research_assignments SET state='submitted',trial_id=$2,lease_owner=NULL,lease_token=NULL,lease_until=NULL WHERE id=$1",[input.assignment.id,trialId]);
        await audit(tx,actor,'research.assignment.submitted',input.assignment.id,{trialId,botId:input.botId});
      }
      await audit(tx,actor,'portfolio.trial.submitted',trialId,{botId:input.botId,datasetId:dataset.id,method:input.method,purpose:dataset.purpose});
      return {id:trialId,state:'submitted',promotionAllowed:false};
    });
  }

  review(actor:Actor,key:string,raw:unknown) {
    permit(actor,'evaluator');const input=parse(z.object({trialId:z.uuid()}).strict(),raw);
    return this.db.command(actor,'portfolio-review',key,input,async tx=>{
      const trial=(await tx.query('SELECT * FROM portfolio_trials WHERE id=$1',[input.trialId])).rows[0];
      requireThat(trial,'Portfolio trial not found',404);
      requireThat(trial.author!==actor.id,'Independent evaluator identity required',403);
      requireThat(trial.state==='submitted','Portfolio trial is not awaiting evaluation');
      const dataset=(await tx.query('SELECT * FROM portfolio_datasets WHERE id=$1',[trial.dataset_id])).rows[0]!;
      await verifiedEvidence(tx,dataset.evidence_id);
      requireThat((await tx.query("SELECT id FROM bots WHERE id=$1 AND state='college'",[trial.bot_id])).rows.length,'Bot no longer eligible');
      const result=portfolioScore(trial.weights,dataset.holdout);
      const baseline=portfolioScore(Array(dataset.assets.length).fill(1/dataset.assets.length),dataset.holdout);
      const reward=result.netReturnBps-result.maxDrawdownBps-baseline.netReturnBps+baseline.maxDrawdownBps;
      const report={...result,baseline,rewardBps:Math.abs(reward)<1e-8?0:reward,observations:dataset.holdout.length,
        costBps:COST_BPS,datasetDigest:dataset.digest,purpose:dataset.purpose,promotionAllowed:false,
        policy:'portfolio-example-v1',calculatedBy:'backend',assumption:'fractional-buy-hold-entry-exit-costs'};
      await tx.query("UPDATE portfolio_trials SET state='evaluated',reviewer=$1,report=$2::jsonb,reviewed_at=now() WHERE id=$3",[actor.id,JSON.stringify(report),trial.id]);
      await audit(tx,actor,'portfolio.trial.evaluated',trial.id,{botId:trial.bot_id,report});
      return {id:trial.id,state:'evaluated',report};
    });
  }

  cancel(actor:Actor,key:string,raw:unknown) {
    permit(actor,'owner');const input=parse(z.object({trialId:z.uuid(),reason:text}).strict(),raw);
    return this.db.command(actor,'portfolio-cancel',key,input,async tx=>{
      const changed=await tx.query("UPDATE portfolio_trials SET state='cancelled' WHERE id=$1 AND state='submitted' RETURNING id",[input.trialId]);
      requireThat(changed.rows.length,'Portfolio trial is not awaiting evaluation');
      await audit(tx,actor,'portfolio.trial.cancelled',input.trialId,{reason:input.reason});
      return {id:input.trialId,state:'cancelled'};
    });
  }

  reports(actor:Actor) {
    permit(actor,'owner','evaluator');
    return this.db.transaction(async tx=>(await tx.query(`SELECT t.*,d.purpose,d.assets,d.digest AS dataset_digest,
      (e.status='verified' AND s.approved=true) AS evidence_active
      FROM portfolio_trials t JOIN portfolio_datasets d ON d.id=t.dataset_id
      JOIN evidence e ON e.id=d.evidence_id JOIN sources s ON s.id=e.source_id
      ORDER BY t.created_at DESC,t.id LIMIT 100`)).rows);
  }
}
