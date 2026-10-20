import { z } from 'zod';
import { Actor, parse, permit, requireThat } from './core.js';
import { Database, Sql, audit } from './database.js';

// Requests in the rolling window are charged their reported tokens, or a conservative reservation
// (inference_reservation) while usage is unknown. Reports are authenticated worker claims, not provider bills.
const CHARGE=`CASE WHEN r.prompt_tokens IS NOT NULL AND r.completion_tokens IS NOT NULL
  THEN r.prompt_tokens+r.completion_tokens ELSE inference_reservation(d.context) END`;

/** Called immediately before every development_requests insert. No ceiling configured means request counts only. */
export async function assertTokenCapacity(tx:Sql,context:unknown){
  const ceiling=(await tx.query('SELECT max_tokens_per_day FROM development_policy WHERE id=1')).rows[0]!.max_tokens_per_day as number|null;
  if(ceiling===null)return;
  const row=(await tx.query(`SELECT coalesce(sum(${CHARGE}),0)::int AS used,inference_reservation($1::jsonb) AS next
    FROM development_requests d LEFT JOIN inference_reports r ON r.request_id=d.id
    WHERE d.created_at>now()-interval '24 hours'`,[JSON.stringify(context)])).rows[0]!;
  requireThat(row.used+row.next<=ceiling,'Model token ceiling reached for the rolling 24 hours');
}

const count=z.number().int().min(0).max(10_000_000);
const reportSchema=z.object({requestId:z.uuid(),outcome:z.enum(['completed','failed','uncertain']),
  failureCode:z.string().regex(/^[A-Z][A-Z0-9_]{2,47}$/).optional(),engine:z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/),
  promptVersion:z.string().regex(/^[a-f0-9]{16}$/),latencyMs:z.number().int().min(0).max(3_600_000).optional(),
  promptTokens:count.optional(),completionTokens:count.optional(),reportedModel:z.string().trim().min(1).max(200).optional()}).strict()
  .refine(v=>(v.outcome==='completed')===(v.failureCode===undefined),'Failure code is required exactly for non-completed outcomes');
type Report=z.infer<typeof reportSchema>;
const columns=(r:Report)=>[r.outcome,r.failureCode??null,r.engine,r.promptVersion,r.latencyMs??null,r.promptTokens??null,
  r.completionTokens??null,r.reportedModel??null];

export class InferenceUsage {
  constructor(private readonly db:Database){}
  /** The request author records one immutable outcome. Allowed after expiry or halt: it is history, not authority. */
  report(actor:Actor,key:string,raw:unknown){
    permit(actor,'researcher');const input=parse(reportSchema,raw);
    return this.db.command(actor,'inference-report',key,input,async tx=>{
      const request=(await tx.query('SELECT author,inference_request_kind(context) AS kind FROM development_requests WHERE id=$1',[input.requestId])).rows[0];
      requireThat(request,'Inference request not found',404);
      requireThat(request.author===actor.id,'Only the assigned researcher can report this inference',403);
      const old=(await tx.query(`SELECT outcome,failure_code,engine,prompt_version,latency_ms,prompt_tokens,completion_tokens,reported_model
        FROM inference_reports WHERE request_id=$1`,[input.requestId])).rows[0];
      if(old){
        requireThat(JSON.stringify(Object.values(old))===JSON.stringify(columns(input)),'A different inference outcome is already recorded');
      }else{
        await tx.query(`INSERT INTO inference_reports(request_id,author,outcome,failure_code,engine,prompt_version,latency_ms,
          prompt_tokens,completion_tokens,reported_model) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[input.requestId,actor.id,...columns(input)]);
        // Routine completions are stored without an inbox entry; failures and uncertain outcomes notify the owner.
        if(input.outcome!=='completed')await audit(tx,actor,'inference.'+input.outcome,input.requestId,
          {kind:request.kind,failureCode:input.failureCode,engine:input.engine,promptVersion:input.promptVersion});
      }
      return {requestId:input.requestId,kind:request.kind,outcome:input.outcome,recorded:true,attested:false};
    });
  }
  status(actor:Actor){
    permit(actor,'owner','evaluator');
    return this.db.transaction(async tx=>{
      const policy=(await tx.query('SELECT revision,enabled,model,max_per_day,max_lifetime,max_tokens_per_day FROM development_policy WHERE id=1')).rows[0]!;
      type Window={requests:number;reported:number;charged_tokens:number;reported_tokens:number;estimated_requests:number;failed_or_uncertain:number};
      const window=(await tx.query<Window>(`SELECT count(*)::int AS requests,count(r.request_id)::int AS reported,
        coalesce(sum(${CHARGE}),0)::int AS charged_tokens,
        coalesce(sum(r.prompt_tokens+r.completion_tokens),0)::int AS reported_tokens,
        count(*) FILTER(WHERE r.prompt_tokens IS NULL OR r.completion_tokens IS NULL)::int AS estimated_requests,
        count(*) FILTER(WHERE r.outcome IN ('failed','uncertain'))::int AS failed_or_uncertain
        FROM development_requests d LEFT JOIN inference_reports r ON r.request_id=d.id
        WHERE d.created_at>now()-interval '24 hours'`)).rows[0]!;
      const group=(key:string)=>tx.query(`SELECT ${key} AS key,count(*)::int AS requests,count(r.request_id)::int AS reported,
        count(*) FILTER(WHERE r.outcome='completed')::int AS completed,count(*) FILTER(WHERE r.outcome='failed')::int AS failed,
        count(*) FILTER(WHERE r.outcome='uncertain')::int AS uncertain,
        coalesce(sum(r.prompt_tokens),0)::int AS prompt_tokens,coalesce(sum(r.completion_tokens),0)::int AS completion_tokens,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY r.latency_ms) AS latency_p50_ms,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY r.latency_ms) AS latency_p95_ms
        FROM development_requests d LEFT JOIN inference_reports r ON r.request_id=d.id GROUP BY 1 ORDER BY 1`);
      const recent=(await tx.query(`SELECT r.request_id,inference_request_kind(d.context) AS kind,d.model->>'name' AS model,r.outcome,
        r.failure_code,r.engine,r.prompt_version,r.latency_ms,r.prompt_tokens,r.completion_tokens,r.reported_model,r.created_at
        FROM inference_reports r JOIN development_requests d ON d.id=r.request_id ORDER BY r.created_at DESC,r.request_id LIMIT 50`)).rows;
      const ceiling=policy.max_tokens_per_day as number|null;
      const last24Hours:Window&{remaining_tokens:number|null}={...window,remaining_tokens:ceiling===null?null:Math.max(0,ceiling-window.charged_tokens)};
      return {policy:{revision:policy.revision,enabled:policy.enabled,model:policy.model?.name??null,maxPerDay:policy.max_per_day,
          maxLifetime:policy.max_lifetime,maxTokensPerDay:ceiling},
        last24Hours,
        byKind:(await group('inference_request_kind(d.context)')).rows,byModel:(await group("d.model->>'name'")).rows,recent,
        scope:'Worker-reported usage and latency; unreported requests are charged a conservative reservation. Not provider billing or attestation.'};
    });
  }
}
