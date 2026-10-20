import { z } from 'zod';
import { Actor, digest, id, parse, permit, requireThat, text, uuid } from './core.js';
import { Database, audit } from './database.js';
import { sharedResearchMemory } from './learning-contract.js';
import { verifiedEvidence } from './organisation.js';
import { portfolioMethod } from './portfolio.js';
import { InferenceUsage, assertTokenCapacity } from './inference-usage.js';

const modelSchema=z.object({name:z.string().trim().min(1).max(200),baseUrl:z.url().max(2048).refine(value=>{
  const url=new URL(value);return !url.username&&!url.password&&!url.search&&!url.hash&&
    (url.protocol==='https:'||(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)));
}),
  // Owner-selected inference engine. Workers refuse tickets whose engine differs from their local configuration.
  engine:z.enum(['hermes-rd-v1','direct-structured-v1']).default('hermes-rd-v1')}).strict();
const shortText=z.string().trim().min(1).max(500);
const proposalSchema=z.object({specialty:id,method:portfolioMethod,hypothesis:shortText,expectedContribution:shortText,
  risks:z.array(z.string().trim().min(1).max(200)).min(1).max(5),
  memoryIds:z.array(z.uuid()).min(1).max(10).refine(v=>new Set(v).size===v.length,'Duplicate memory reference')}).strict();
const runtimes={
  'hermes-rd-v1':{engine:'hermes-rd-v1',sourceRevision:'f97608f178d1ffeca59860195ab7da295f7c8e5f',tools:[],contractVersion:1},
  // Plain chat completion with a per-task JSON Schema; no agent loop, tools or upstream agent code.
  'direct-structured-v1':{engine:'direct-structured-v1',sourceRevision:null,tools:[],contractVersion:1,decoding:'json-schema'},
} as const;

export class ResearchDevelopment {
  private usage?:InferenceUsage;
  constructor(private readonly db:Database) {}
  inference(){return this.usage??=new InferenceUsage(this.db);}
  configure(actor:Actor,key:string,raw:unknown) {
    permit(actor,'owner');const input=parse(z.object({expectedRevision:z.number().int().nonnegative(),enabled:z.boolean(),model:modelSchema.nullable(),
      maxPerDay:z.number().int().min(1).max(10),maxLifetime:z.number().int().min(1).max(100),
      // Omitted keeps the current ceiling, so resubmitting an older policy file cannot silently remove it; null removes it.
      maxTokensPerDay:z.number().int().min(1000).max(10_000_000).nullable().optional()}).strict(),raw);
    requireThat(!input.enabled||input.model,'Select an existing model endpoint before enabling R&D',400);
    return this.db.command(actor,'development-policy',key,input,async tx=>{
      const old=(await tx.query('SELECT revision FROM development_policy WHERE id=1')).rows[0]!;
      requireThat(old.revision===input.expectedRevision,'Development policy revision changed');
      await tx.query(`UPDATE development_policy SET revision=revision+1,enabled=$1,model=$2::jsonb,max_per_day=$3,max_lifetime=$4,
        max_tokens_per_day=CASE WHEN $5::boolean THEN $6::integer ELSE max_tokens_per_day END WHERE id=1`,
        [input.enabled,input.model?JSON.stringify({name:input.model.name,baseUrl:input.model.baseUrl,...runtimes[input.model.engine]}):null,input.maxPerDay,input.maxLifetime,
          input.maxTokensPerDay!==undefined,input.maxTokensPerDay??null]);
      await audit(tx,actor,'development.policy.changed','research-development',{...input,revision:old.revision+1});
      return {revision:old.revision+1};
    });
  }
  request(actor:Actor,key:string,raw:unknown) {
    permit(actor,'researcher');const input=parse(z.object({datasetId:z.uuid(),method:portfolioMethod}).strict(),raw);
    return this.db.command(actor,'development-request',key,input,async tx=>{
      const policy=(await tx.query('SELECT * FROM development_policy WHERE id=1')).rows[0]!;
      requireThat(policy.enabled&&policy.model,'R&D inference is disabled');
      requireThat(!(await tx.query('SELECT halted FROM system_lock WHERE id=1')).rows[0]!.halted,'System is halted');
      const counts=(await tx.query(`SELECT count(*)::int AS total,count(*) FILTER(WHERE created_at>now()-interval '24 hours')::int AS recent FROM development_requests`)).rows[0]!;
      requireThat(counts.total<policy.max_lifetime&&counts.recent<policy.max_per_day,'R&D inference request budget exhausted');
      const dataset=(await tx.query('SELECT evidence_id,training FROM portfolio_datasets WHERE id=$1',[input.datasetId])).rows[0];
      requireThat(dataset,'Target dataset not found',404);await verifiedEvidence(tx,dataset.evidence_id);
      const before=dataset.training.at(-1).timestamp;
      const memories=(await sharedResearchMemory(tx,input.method,undefined,before)).slice(0,10);
      requireThat(memories.length,'No prior verified memory for this training cutoff');
      const capabilities=(await tx.query('SELECT specialty,method FROM bots ORDER BY created_at,id LIMIT 100')).rows;
      const context={datasetId:input.datasetId,method:input.method,beforeTrainingEnd:before,
        memories:memories.map(m=>({id:m.id,content:m.content})),existingCapabilities:capabilities};
      const requestId=uuid(),hash=digest(context);
      await assertTokenCapacity(tx,context);
      const row=(await tx.query(`INSERT INTO development_requests(id,author,policy_revision,model,context,context_hash,expires_at)
        VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,now()+interval '180 seconds') RETURNING expires_at`,
        [requestId,actor.id,policy.revision,JSON.stringify(policy.model),JSON.stringify(context),hash])).rows[0]!;
      await audit(tx,actor,'development.request.authorised',requestId,{datasetId:input.datasetId,policyRevision:policy.revision,contextHash:hash});
      return {id:requestId,model:policy.model,context,contextHash:hash,expiresAt:new Date(row.expires_at).toISOString()};
    });
  }
  submit(actor:Actor,key:string,raw:unknown) {
    permit(actor,'researcher');const input=parse(z.object({requestId:z.uuid(),contextHash:z.string().regex(/^[a-f0-9]{64}$/),proposal:proposalSchema}).strict(),raw);
    return this.db.command(actor,'development-submit',key,input,async tx=>{
      const request=(await tx.query('SELECT * FROM development_requests WHERE id=$1 AND author=$2 AND expires_at>now()',[input.requestId,actor.id])).rows[0];
      requireThat(request,'Current R&D request required');
      requireThat(typeof request.context.datasetId==='string'&&Array.isArray(request.context.memories),'Portfolio R&D request required');
      const policy=(await tx.query('SELECT * FROM development_policy WHERE id=1')).rows[0]!;
      requireThat(policy.enabled&&policy.revision===request.policy_revision,'R&D policy changed or paused');
      requireThat(!(await tx.query('SELECT halted FROM system_lock WHERE id=1')).rows[0]!.halted,'System is halted');
      requireThat(request.context_hash===input.contextHash&&request.context.method===input.proposal.method,'R&D context mismatch');
      const target=(await tx.query('SELECT evidence_id FROM portfolio_datasets WHERE id=$1',[request.context.datasetId])).rows[0]!;
      requireThat(target,'Portfolio dataset unavailable');
      await verifiedEvidence(tx,target.evidence_id);
      const current=await sharedResearchMemory(tx,input.proposal.method,undefined,request.context.beforeTrainingEnd);
      requireThat(input.proposal.memoryIds.every(memoryId=>request.context.memories.some((m:{id:string})=>m.id===memoryId)&&current.some(m=>m.id===memoryId)),
        'Proposal cites unavailable or unapproved memory');
      await tx.query('INSERT INTO development_proposals(request_id,proposal) VALUES($1,$2::jsonb)',[request.id,JSON.stringify(input.proposal)]);
      await audit(tx,actor,'development.proposal.submitted',request.id,{specialty:input.proposal.specialty,method:input.proposal.method,scope:'unverified-hypothesis'});
      return {id:request.id,state:'awaiting-review',recruitmentAllowed:false};
    });
  }
  preflight(actor:Actor,raw:unknown) {
    permit(actor,'researcher');const input=parse(z.object({requestId:z.uuid()}).strict(),raw);
    return this.db.transaction(async tx=>{
      const request=(await tx.query('SELECT * FROM development_requests WHERE id=$1 AND author=$2 AND expires_at>now()',[input.requestId,actor.id])).rows[0];
      requireThat(request,'Current R&D request required');
      requireThat(typeof request.context.datasetId==='string'&&Array.isArray(request.context.memories),'Portfolio R&D request required');
      const policy=(await tx.query('SELECT enabled,revision FROM development_policy WHERE id=1')).rows[0]!;
      requireThat(policy.enabled&&policy.revision===request.policy_revision,'R&D policy changed or paused');
      requireThat(!(await tx.query('SELECT halted FROM system_lock WHERE id=1')).rows[0]!.halted,'System is halted');
      const target=(await tx.query('SELECT evidence_id FROM portfolio_datasets WHERE id=$1',[request.context.datasetId])).rows[0]!;
      requireThat(target,'Portfolio dataset unavailable');
      await verifiedEvidence(tx,target.evidence_id);
      const current=await sharedResearchMemory(tx,request.context.method,undefined,request.context.beforeTrainingEnd);
      requireThat(request.context.memories.every((item:{id:string})=>current.some(m=>m.id===item.id)),'R&D memory support changed');
      requireThat(!(await tx.query('SELECT request_id FROM development_proposals WHERE request_id=$1',[request.id])).rows.length,'R&D request already submitted');
      return {authorised:true};
    });
  }
  review(actor:Actor,key:string,raw:unknown) {
    permit(actor,'owner','evaluator');const input=parse(z.object({requestId:z.uuid(),decision:z.enum(['recommended','rejected']),reason:text}).strict(),raw);
    return this.db.command(actor,'development-review',key,input,async tx=>{
      const row=(await tx.query('SELECT q.*,p.proposal FROM development_requests q JOIN development_proposals p ON p.request_id=q.id WHERE q.id=$1',[input.requestId])).rows[0];
      requireThat(row,'R&D proposal not found',404);requireThat(row.author!==actor.id,'Independent R&D review required',403);
      if(input.decision==='recommended'){
        const target=(await tx.query('SELECT evidence_id FROM portfolio_datasets WHERE id=$1',[row.context.datasetId])).rows[0]!;
        await verifiedEvidence(tx,target.evidence_id);
        const memory=await sharedResearchMemory(tx,row.proposal.method,undefined,row.context.beforeTrainingEnd);
        requireThat(row.proposal.memoryIds.every((memoryId:string)=>memory.some(m=>m.id===memoryId)),'Supporting memory is no longer valid');
        requireThat(!(await tx.query('SELECT id FROM bots WHERE lower(specialty)=lower($1) AND method=$2',[row.proposal.specialty,row.proposal.method])).rows.length,'Declared capability already exists');
      }
      await tx.query('INSERT INTO development_reviews(request_id,decision,reason,reviewer) VALUES($1,$2,$3,$4)',[input.requestId,input.decision,input.reason,actor.id]);
      await audit(tx,actor,'development.proposal.'+input.decision,input.requestId,{reason:input.reason,recruitmentAllowed:false});
      return {id:input.requestId,decision:input.decision,recruitmentAllowed:false};
    });
  }
  status(actor:Actor) {
    permit(actor,'owner','evaluator');return this.db.transaction(async tx=>({
      policy:(await tx.query('SELECT * FROM development_policy WHERE id=1')).rows[0],
      requests:(await tx.query(`SELECT q.id,q.author,q.model,q.created_at,q.expires_at,p.proposal,r.decision,r.reason,
        (q.expires_at<=now() AND p.request_id IS NULL) AS expired FROM development_requests q
        LEFT JOIN development_proposals p ON p.request_id=q.id LEFT JOIN development_reviews r ON r.request_id=q.id
        ORDER BY q.created_at DESC,q.id LIMIT 100`)).rows,
      scope:'unverified-r-and-d-hypotheses',automaticRecruitment:false,
    }));
  }
}
