import { z } from 'zod';
import { Actor, digest, parse, permit, requireThat } from './core.js';
import { audit, Database } from './database.js';

const hash=z.string().regex(/^[a-f0-9]{64}$/);
const observation=z.object({sequence:z.number().int().min(1).max(16),stage:z.enum(['baseline','candidate','submission']),
  attempt:z.number().int().min(1).max(2),state:z.enum(['started','succeeded','failed','interrupted','unconfirmed','confirmed']),
  code:z.enum(['NONE','TIMEOUT','VALIDATION_FAILED','CLEANUP_UNCONFIRMED','EXECUTION_FAILED','INTERRUPTED','SUBMISSION_UNCONFIRMED'])}).strict()
  .refine(e=>e.stage==='submission'?
    e.attempt===1&&((e.state==='unconfirmed'&&e.code==='SUBMISSION_UNCONFIRMED')||(e.state==='confirmed'&&e.code==='NONE')):
    ((e.state==='started'||e.state==='succeeded')&&e.code==='NONE')||
    (e.state==='interrupted'&&e.code==='INTERRUPTED')||
    (e.state==='failed'&&['TIMEOUT','VALIDATION_FAILED','CLEANUP_UNCONFIRMED','EXECUTION_FAILED'].includes(e.code)),
    'Stage, state and code must agree');
type Observation=z.infer<typeof observation>;

export function recordExecution(db:Database,actor:Actor,key:string,raw:unknown){
  permit(actor,'researcher');const input=parse(z.object({experimentId:z.uuid(),planHash:hash,baselineHash:hash,candidateHash:hash,
    mode:z.enum(['trusted-local-process-only','docker-linux-container']),imageId:z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
    events:z.array(observation).min(1).max(16)}).strict().refine(v=>(v.mode==='docker-linux-container')===(v.imageId!==undefined),'Image must match execution mode'),raw);
  return db.command(actor,'skill-execution-report',key,input,async tx=>{
    const plan=(await tx.query('SELECT * FROM skill_experiments WHERE id=$1',[input.experimentId])).rows[0];
    requireThat(plan&&plan.researcher===actor.id,'Assigned experiment researcher required',403);
    requireThat(plan.plan_hash===input.planHash&&plan.baseline_hash===input.baselineHash&&plan.candidate_hash===input.candidateHash,'Execution report plan mismatch');
    // Operational evidence remains reportable after halt, expiry or cancellation. It never authorises work.
    const stream=(await tx.query('SELECT * FROM skill_execution_streams WHERE experiment_id=$1',[plan.id])).rows[0];
    if(stream)requireThat(stream.mode===input.mode&&stream.image_id===(input.imageId??null)&&stream.reporter===actor.id,'Execution stream identity changed');
    else await tx.query('INSERT INTO skill_execution_streams(experiment_id,reporter,mode,image_id) VALUES($1,$2,$3,$4)',[plan.id,actor.id,input.mode,input.imageId??null]);
    const history=(await tx.query('SELECT event FROM skill_execution_events WHERE experiment_id=$1 ORDER BY sequence',[plan.id])).rows.map(r=>r.event as Observation);
    let recorded=0;
    for(const event of input.events){
      const existing=history.find(e=>e.sequence===event.sequence);
      if(existing){requireThat(digest(existing)===digest(event),'Execution history cannot be rewritten');continue;}
      requireThat(event.sequence===history.length+1,'Execution events must be contiguous');
      const prior=history.filter(e=>e.stage===event.stage&&e.attempt===event.attempt).at(-1);
      if(event.stage==='submission'){
        requireThat(!prior||(prior.state==='unconfirmed'&&event.state==='confirmed'),'Submission observation already final');
      }else if(!prior){
        requireThat(event.state==='started','Record execution start before its outcome');
        if(event.attempt===2){
          const first=history.filter(e=>e.stage===event.stage&&e.attempt===1).at(-1);
          requireThat(first&&(first.state==='failed'||first.state==='interrupted'),'Retry requires a prior failed or interrupted attempt');
        }
      }else requireThat(prior.state==='started'&&['succeeded','failed','interrupted'].includes(event.state),'Execution attempt already final');
      await tx.query('INSERT INTO skill_execution_events(experiment_id,sequence,event) VALUES($1,$2,$3::jsonb)',[plan.id,event.sequence,JSON.stringify(event)]);
      await audit(tx,actor,'worker.execution.reported.'+event.state,plan.id,{...event,mode:input.mode,workerReported:true,verifiedExecution:false});
      history.push(event);recorded++;
    }
    return {experimentId:plan.id,recorded,lastSequence:history.length,verifiedExecution:false};
  });
}

export function executionStatus(db:Database,actor:Actor){
  permit(actor,'owner','evaluator');return db.transaction(async tx=>({
    streams:(await tx.query(`SELECT p.id AS experiment_id,p.researcher,p.plan_hash,s.mode,s.image_id,
      sub.experiment_id IS NOT NULL AS backend_submission_received,r.outcome AS backend_review_outcome,
      c.experiment_id IS NOT NULL AS cancelled,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('event',e.event,'receivedAt',e.received_at) ORDER BY e.sequence)
        FROM skill_execution_events e WHERE e.experiment_id=p.id),'[]'::jsonb) AS observations
      FROM skill_experiments p LEFT JOIN skill_execution_streams s ON s.experiment_id=p.id
      LEFT JOIN skill_experiment_submissions sub ON sub.experiment_id=p.id
      LEFT JOIN skill_experiment_reviews r ON r.experiment_id=p.id
      LEFT JOIN skill_experiment_cancellations c ON c.experiment_id=p.id
      ORDER BY p.created_at DESC,p.id LIMIT 100`)).rows,
    verifiedExecution:false,liveness:'not-established',
    limitation:'Authenticated worker observations, possibly delivered late; backend submission and review are independent facts. No release or financial authority.',
  }));
}
