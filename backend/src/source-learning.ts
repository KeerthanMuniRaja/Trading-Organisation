import { z } from 'zod';
import { Actor,digest,id,parse,permit,requireThat,text,uuid } from './core.js';
import { audit,Database,Row,Sql } from './database.js';

const proposalSchema=z.object({lesson:z.string().trim().min(1).max(500),quote:z.string().min(10).max(500),
  limitation:z.string().trim().min(1).max(300)}).strict();
async function source(tx:Sql,evidenceId:string){
  const e=(await tx.query(`SELECT e.id,e.content,e.content_hash,e.published_at,e.source_id,o.title,o.url,o.observed_at
    FROM evidence e JOIN source_observations o ON o.evidence_id=e.id JOIN sources s ON s.id=e.source_id
    WHERE e.id=$1 AND e.status='verified' AND s.approved AND e.published_at<=now()`,[evidenceId])).rows[0];
  requireThat(e,'Currently verified article observation required');return e;
}
async function active(tx:Sql,r:Row){
  const p=(await tx.query('SELECT * FROM development_policy WHERE id=1')).rows[0]!;
  requireThat(p.enabled&&p.revision===r.policy_revision,'Source learning policy changed or disabled');
  requireThat(!(await tx.query('SELECT halted FROM system_lock WHERE id=1')).rows[0]!.halted,'System halted');
  requireThat((await tx.query("SELECT 1 FROM bots WHERE id=$1 AND state<>'retired'",[r.bot_id])).rows.length,'Active bot required');
  const e=await source(tx,r.evidence_id);requireThat(e.content_hash===r.context.article.snapshotHash,'Source snapshot changed');return e;
}
async function load(tx:Sql,requestId:string){
  const r=(await tx.query(`SELECT d.*,s.bot_id,s.evidence_id,d.expires_at>now() AS fresh FROM development_requests d
    JOIN source_learning_requests s ON s.request_id=d.id WHERE d.id=$1`,[requestId])).rows[0];
  requireThat(r,'Source learning request not found',404);return r;
}
export class SourceLearning {
  constructor(private readonly db:Database){}
  request(actor:Actor,key:string,raw:unknown){
    permit(actor,'researcher');const input=parse(z.object({botId:id,evidenceId:z.uuid()}).strict(),raw);
    return this.db.command(actor,'source-learning-request',key,input,async tx=>{
      const p=(await tx.query('SELECT * FROM development_policy WHERE id=1')).rows[0]!;
      requireThat(p.enabled&&p.model,'Enable an approved development model profile');
      requireThat(!(await tx.query('SELECT halted FROM system_lock WHERE id=1')).rows[0]!.halted,'System halted');
      const bot=(await tx.query("SELECT id,specialty,contribution FROM bots WHERE id=$1 AND state<>'retired'",[input.botId])).rows[0];requireThat(bot,'Active bot required');
      const e=await source(tx,input.evidenceId);
      const counts=(await tx.query("SELECT count(*)::int AS total,count(*) FILTER(WHERE created_at>now()-interval '24 hours')::int AS daily FROM development_requests")).rows[0]!;
      requireThat(counts.total<p.max_lifetime&&counts.daily<p.max_per_day,'Shared development request capacity reached');
      const context={kind:'source-lesson-v1',bot,article:{evidenceId:e.id,sourceId:e.source_id,title:e.title,url:e.url,
        content:e.content,snapshotHash:e.content_hash,publishedAt:new Date(e.published_at).toISOString(),observedAt:new Date(e.observed_at).toISOString()}};
      const requestId=uuid(),contextHash=digest(context);
      const saved=(await tx.query(`INSERT INTO development_requests(id,author,policy_revision,model,context,context_hash,expires_at)
        VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,now()+interval '10 minutes') RETURNING expires_at`,
        [requestId,actor.id,p.revision,JSON.stringify(p.model),JSON.stringify(context),contextHash])).rows[0]!;
      await tx.query('INSERT INTO source_learning_requests VALUES($1,$2,$3)',[requestId,bot.id,e.id]);
      await audit(tx,actor,'source.learning.requested',requestId,{botId:bot.id,evidenceId:e.id,contextHash});
      return {id:requestId,model:p.model,context,contextHash,expiresAt:new Date(saved.expires_at).toISOString()};
    });
  }
  preflight(actor:Actor,raw:unknown){
    permit(actor,'researcher');const input=parse(z.object({requestId:z.uuid()}).strict(),raw);
    return this.db.transaction(async tx=>{const r=await load(tx,input.requestId);requireThat(r.author===actor.id&&r.fresh,'Current assigned request required');await active(tx,r);
      requireThat(!(await tx.query('SELECT 1 FROM source_learning_proposals WHERE request_id=$1',[r.id])).rows.length,'Proposal already submitted');return {authorised:true};});
  }
  submit(actor:Actor,key:string,raw:unknown){
    permit(actor,'researcher');const input=parse(z.object({requestId:z.uuid(),contextHash:z.string().regex(/^[a-f0-9]{64}$/),proposal:proposalSchema}).strict(),raw);
    return this.db.command(actor,'source-learning-submit',key,input,async tx=>{
      const r=await load(tx,input.requestId);requireThat(r.author===actor.id&&r.fresh,'Current assigned request required');const e=await active(tx,r);
      requireThat(input.contextHash===r.context_hash,'Source learning context changed');
      requireThat(input.proposal.quote.trim().length>=10&&e.content.includes(input.proposal.quote),'Quote must occur exactly in the frozen article');
      const old=(await tx.query('SELECT * FROM source_learning_proposals WHERE request_id=$1',[r.id])).rows[0];
      if(old){requireThat(digest(old.proposal)===digest(input.proposal),'Proposal already fixed');return {requestId:r.id,lessonId:old.lesson_id,state:'awaiting-review'};}
      const lessonId=uuid(),content=input.proposal.lesson+'\nSupporting excerpt: '+input.proposal.quote+'\nLimitation: '+input.proposal.limitation;
      await tx.query("INSERT INTO lessons(id,bot_id,content,evidence_id,status,author) VALUES($1,$2,$3,$4,'unverified',$5)",[lessonId,r.bot_id,content,r.evidence_id,actor.id]);
      await tx.query('INSERT INTO source_learning_proposals(request_id,lesson_id,proposal) VALUES($1,$2,$3::jsonb)',[r.id,lessonId,JSON.stringify(input.proposal)]);
      await audit(tx,actor,'source.learning.proposed',r.id,{lessonId,evidenceId:r.evidence_id});
      return {requestId:r.id,lessonId,state:'awaiting-review'};
    });
  }
  review(actor:Actor,key:string,raw:unknown){
    permit(actor,'evaluator');const input=parse(z.object({requestId:z.uuid(),decision:z.enum(['accepted','rejected']),reason:text}).strict(),raw);
    return this.db.command(actor,'source-learning-review',key,input,async tx=>{
      const r=await load(tx,input.requestId);requireThat(r.author!==actor.id,'Independent evaluator required',403);
      const p=(await tx.query('SELECT * FROM source_learning_proposals WHERE request_id=$1',[r.id])).rows[0];requireThat(p,'Submitted proposal required');
      const old=(await tx.query('SELECT * FROM source_learning_reviews WHERE request_id=$1',[r.id])).rows[0];
      if(old){requireThat(old.decision===input.decision&&old.reason===input.reason,'Review already fixed');return {requestId:r.id,lessonId:p.lesson_id,decision:old.decision};}
      if(input.decision==='accepted')await active(tx,r);
      await tx.query('INSERT INTO source_learning_reviews(request_id,reviewer,decision,reason) VALUES($1,$2,$3,$4)',[r.id,actor.id,input.decision,input.reason]);
      if(input.decision==='accepted')await tx.query("UPDATE lessons SET status='verified',reviewer=$1 WHERE id=$2",[actor.id,p.lesson_id]);
      await audit(tx,actor,'source.learning.'+input.decision,r.id,{lessonId:p.lesson_id,reason:input.reason,demonstratedLearning:false});
      return {requestId:r.id,lessonId:p.lesson_id,decision:input.decision};
    });
  }
  status(actor:Actor){
    permit(actor,'owner','evaluator');return this.db.transaction(async tx=>({items:(await tx.query(`SELECT s.*,d.author,d.context,d.model,
      p.lesson_id,p.proposal,r.decision,r.reason,r.reviewer FROM source_learning_requests s JOIN development_requests d ON d.id=s.request_id
      LEFT JOIN source_learning_proposals p ON p.request_id=s.request_id LEFT JOIN source_learning_reviews r ON r.request_id=s.request_id
      ORDER BY d.created_at DESC,s.request_id LIMIT 100`)).rows,scope:'proposed-source-lessons-not-proven-skill'}));
  }
}
