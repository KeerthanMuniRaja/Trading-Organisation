import { z } from 'zod';
import { Actor, digest, id, parse, permit, positiveMoney, requireThat, text, timestamp, uuid } from './core.js';
import { Database, audit } from './database.js';
import { verifiedEvidence } from './organisation.js';

const bar=z.object({timestamp,closePaise:positiveMoney}).strict();
const bars=z.array(bar).min(30).max(2000).refine(v=>v.every((b,i)=>i===0||Date.parse(b.timestamp)>Date.parse(v[i-1]!.timestamp)),'Bars must be strictly chronological');
const candidate=z.object({kind:z.literal('momentum'),lookback:z.number().int().min(2).max(20)}).strict();
const researchResult=z.object({candidate,trainingReport:z.object({selectedScoreBps:z.number().finite(),trials:z.array(z.object({lookback:z.number().int().min(2).max(20),netReturnBps:z.number().finite()}).strict()).min(1).max(20)}).strict()}).strict();
const evaluationResult=z.object({observations:z.number().int().min(20).max(2000),netReturnBps:z.number().finite().min(-10000).max(1000000),baselineReturnBps:z.number().finite().min(-10000).max(1000000),maxDrawdownBps:z.number().finite().min(0).max(10000),turnover:z.number().int().min(0).max(4000),costBps:z.number().int().min(1).max(1000),datasetDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export class Research {
  constructor(private readonly db:Database) {}
  dataset(actor:Actor,key:string,raw:unknown) {
    permit(actor,'owner');const input=parse(z.object({evidenceId:z.uuid(),training:bars,holdout:bars}).strict(),raw);
    requireThat(Date.parse(input.training.at(-1)!.timestamp)<Date.parse(input.holdout[0]!.timestamp),'Training must precede holdout',400);
    return this.db.command(actor,'dataset',key,input,async tx=>{
      await verifiedEvidence(tx,input.evidenceId);const datasetId=uuid(),hash=digest(input);
      await tx.query('INSERT INTO datasets(id,evidence_id,training,holdout,digest) VALUES($1,$2,$3::jsonb,$4::jsonb,$5)',[datasetId,input.evidenceId,JSON.stringify(input.training),JSON.stringify(input.holdout),hash]);
      await audit(tx,actor,'dataset.registered',datasetId,{evidenceId:input.evidenceId,digest:hash});return {id:datasetId,digest:hash};
    });
  }
  experiment(actor:Actor,key:string,raw:unknown) {
    permit(actor,'researcher');const input=parse(z.object({botId:id,datasetId:z.uuid(),hypothesis:text}).strict(),raw);
    return this.db.command(actor,'experiment',key,input,async tx=>{
      requireThat((await tx.query("SELECT id FROM bots WHERE id=$1 AND state='college'",[input.botId])).rows.length,'A college candidate is required');
      requireThat(!(await tx.query('SELECT id FROM bots WHERE id=$1 AND lifecycle_managed=true',[input.botId])).rows.length,'Managed students use the example-only portfolio research path',403);
      const dataset=(await tx.query('SELECT * FROM datasets WHERE id=$1',[input.datasetId])).rows[0];requireThat(dataset,'Dataset not found',404);await verifiedEvidence(tx,dataset.evidence_id);
      requireThat(!(await tx.query('SELECT id FROM experiments WHERE bot_id=$1 AND dataset_id=$2',[input.botId,input.datasetId])).rows.length,'This bot already used this holdout; register a fresh dataset');
      const experimentId=uuid(),jobId=uuid();await tx.query("INSERT INTO experiments(id,bot_id,dataset_id,hypothesis,state) VALUES($1,$2,$3,$4,'queued')",[experimentId,input.botId,input.datasetId,input.hypothesis]);
      await tx.query("INSERT INTO jobs(id,experiment_id,kind,state) VALUES($1,$2,'research','queued')",[jobId,experimentId]);
      await audit(tx,actor,'experiment.created',experimentId,input);return {id:experimentId,jobId,state:'queued'};
    });
  }
  claim(actor:Actor) {
    permit(actor,'researcher','evaluator');const kind=actor.role==='researcher'?'research':'evaluation';
    return this.db.transaction(async tx=>{
      const exhausted=(await tx.query("SELECT id,experiment_id FROM jobs WHERE kind=$1 AND state='running' AND lease_until<now() AND attempts>=3",[kind])).rows;
      for(const failed of exhausted) {
        await tx.query("UPDATE jobs SET state='failed',lease_until=NULL WHERE id=$1",[failed.id]);
        await tx.query("UPDATE experiments SET state='rejected' WHERE id=$1",[failed.experiment_id]);
        const incidentId=uuid();await tx.query("INSERT INTO incidents(id,reporter,description,severity,status) VALUES($1,$2,$3,'warning','open')",[incidentId,actor.id,'Research job exhausted its retry budget: '+failed.id]);
        await audit(tx,actor,'job.retry.budget.exhausted',failed.id,{incidentId});
      }
      const owned=(await tx.query("SELECT * FROM jobs WHERE kind=$1 AND state='running' AND worker=$2 AND lease_until>now() ORDER BY id LIMIT 1 FOR UPDATE",[kind,actor.id])).rows[0];
      const job=owned??(await tx.query("SELECT * FROM jobs WHERE kind=$1 AND (state='queued' OR (state='running' AND lease_until<now())) AND attempts<3 ORDER BY id LIMIT 1 FOR UPDATE",[kind])).rows[0];
      if(!job)return {job:null};
      const experiment=(await tx.query('SELECT * FROM experiments WHERE id=$1',[job.experiment_id])).rows[0]!;
      const dataset=(await tx.query('SELECT * FROM datasets WHERE id=$1',[experiment.dataset_id])).rows[0]!;
      await verifiedEvidence(tx,dataset.evidence_id);
      const leaseToken=owned?job.lease_token:uuid();
      if(!owned){await tx.query("UPDATE jobs SET state='running',worker=$1,lease_token=$2,lease_until=now()+interval '120 seconds',attempts=attempts+1 WHERE id=$3",[actor.id,leaseToken,job.id]);
        await audit(tx,actor,job.state==='running'?'job.lease.recovered':'job.claimed',job.id,{kind,attempt:job.attempts+1});}
      const payload=kind==='research'?{training:dataset.training,costBps:15}:{holdout:dataset.holdout,warmup:dataset.training.slice(-20),candidate:experiment.candidate,costBps:15,datasetDigest:dataset.digest};
      return {job:{id:job.id,experimentId:experiment.id,kind,leaseToken,payload}};
    });
  }
  complete(actor:Actor,key:string,raw:unknown) {
    permit(actor,'researcher','evaluator');const envelope=parse(z.object({jobId:z.uuid(),leaseToken:z.uuid(),result:z.unknown()}).strict(),raw);
    const result=actor.role==='researcher'?parse(researchResult,envelope.result):parse(evaluationResult,envelope.result);
    return this.db.command(actor,'job-complete',key,{...envelope,result},async tx=>{
      const job=(await tx.query('SELECT * FROM jobs WHERE id=$1',[envelope.jobId])).rows[0];
      requireThat(job&&job.state==='running'&&job.worker===actor.id&&job.lease_token===envelope.leaseToken&&new Date(job.lease_until).getTime()>Date.now(),'Job lease is not valid',403);
      requireThat(job.kind===(actor.role==='researcher'?'research':'evaluation'),'Wrong worker role',403);
      const experiment=(await tx.query('SELECT * FROM experiments WHERE id=$1',[job.experiment_id])).rows[0]!;
      const sourceDataset=(await tx.query('SELECT evidence_id FROM datasets WHERE id=$1',[experiment.dataset_id])).rows[0]!;
      await verifiedEvidence(tx,sourceDataset.evidence_id);
      const bot=(await tx.query('SELECT * FROM bots WHERE id=$1',[experiment.bot_id])).rows[0]!;requireThat(bot.state==='college','Bot no longer eligible');
      if(actor.role==='researcher') {
        const report=result as z.infer<typeof researchResult>;
        requireThat(report.trainingReport.trials.some(t=>t.lookback===report.candidate.lookback),'Selected candidate must appear in trial history',400);
        await tx.query("UPDATE experiments SET candidate=$1::jsonb,training_report=$2::jsonb,state='evaluating' WHERE id=$3",[JSON.stringify(report.candidate),JSON.stringify(report.trainingReport),experiment.id]);
        await tx.query("INSERT INTO jobs(id,experiment_id,kind,state) VALUES($1,$2,'evaluation','queued')",[uuid(),experiment.id]);
      } else {
        const report=result as z.infer<typeof evaluationResult>;
        const trainingJob=(await tx.query("SELECT worker FROM jobs WHERE experiment_id=$1 AND kind='research'",[experiment.id])).rows[0]!;
        requireThat(trainingJob.worker!==actor.id,'Independent evaluator identity required',403);
        const dataset=(await tx.query('SELECT * FROM datasets WHERE id=$1',[experiment.dataset_id])).rows[0]!;
        requireThat(report.datasetDigest===dataset.digest&&report.observations===dataset.holdout.length&&report.costBps===15,'Evaluation contract mismatch',400);
        const passed=report.netReturnBps>0&&report.netReturnBps>report.baselineReturnBps&&report.maxDrawdownBps<=1500;
        await tx.query('UPDATE experiments SET evaluation_report=$1::jsonb,state=$2 WHERE id=$3',[JSON.stringify(report),passed?'passed':'rejected',experiment.id]);
        if(passed)await tx.query("UPDATE bots SET state='paper' WHERE id=$1",[bot.id]);
        await audit(tx,actor,passed?'bot.paper.qualified':'experiment.rejected',bot.id,{experimentId:experiment.id,report,policy:'paper-academy-v1'});
      }
      await tx.query("UPDATE jobs SET state='completed',lease_until=NULL WHERE id=$1",[job.id]);await audit(tx,actor,'job.completed',job.id,{kind:job.kind});
      return {jobId:job.id,state:'completed'};
    });
  }
  reports(actor:Actor) {
    permit(actor,'owner','evaluator');return this.db.transaction(async tx=>(await tx.query('SELECT * FROM experiments ORDER BY created_at DESC LIMIT 100')).rows);
  }
  coordination(actor:Actor) {
    permit(actor,'coordinator');return this.db.transaction(async tx=>(await tx.query('SELECT id,bot_id,hypothesis,state,created_at FROM experiments ORDER BY created_at DESC LIMIT 100')).rows);
  }
}
