import { z } from 'zod';
import { Actor, digest, id, parse, permit, requireThat, text, uuid } from './core.js';
import { audit, Database, Row, Sql } from './database.js';
import { sharedResearchMemory } from './learning-contract.js';
import { assertTokenCapacity } from './inference-usage.js';

const short=z.string().trim().min(1).max(500);
const proposalSchema=z.object({summary:short,application:short,lessonIds:z.array(z.uuid()).min(1).max(5),
  checks:z.array(z.string().trim().min(1).max(200)).min(1).max(5),risks:z.array(z.string().trim().min(1).max(200)).min(1).max(5)}).strict();
async function lessonRows(tx:Sql,ids:string[]){
  const rows=(await tx.query(`SELECT l.id,l.bot_id,l.content,l.evidence_id,
    (l.status='verified' AND e.status='verified' AND s.approved AND e.published_at<=now()) AS usable,
    e.source_id,e.kind,e.content_hash,s.name AS source_name,e.published_at,e.received_at,
    o.url AS article_url,o.title AS article_title,o.observed_at
    FROM lessons l JOIN evidence e ON e.id=l.evidence_id JOIN sources s ON s.id=e.source_id
    LEFT JOIN source_observations o ON o.evidence_id=e.id WHERE l.id=ANY($1::uuid[]) ORDER BY l.id`,[ids])).rows;
  requireThat(rows.length===ids.length&&rows.every(r=>r.usable),'Currently verified lessons and sources required');return rows;
}
async function active(tx:Sql,request:Row){
  const policy=(await tx.query('SELECT * FROM development_policy WHERE id=1')).rows[0]!;
  requireThat(policy.enabled&&policy.revision===request.policy_revision,'Knowledge development policy changed or disabled');
  requireThat(!(await tx.query('SELECT halted FROM system_lock WHERE id=1')).rows[0]!.halted,'System halted');
  const bot=(await tx.query("SELECT id FROM bots WHERE id=$1 AND state<>'retired'",[request.bot_id])).rows[0];
  requireThat(bot,'Active recipient bot required');
  await lessonRows(tx,request.context.lessons.map((l:Row)=>l.id));
}
export class BotKnowledge {
  constructor(private readonly db:Database){}
  discover(actor:Actor,raw:unknown){
    permit(actor,'owner','researcher','evaluator');
    const input=parse(z.object({botId:id,query:z.string().trim().min(3).max(200),
      limit:z.number().int().min(1).max(20).default(5)}).strict(),raw);
    const terms=[...new Set(input.query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu)??[])];
    requireThat(terms.length>0&&terms.length<=12,'Use 1–12 distinct search terms of at least three characters',400);
    return this.db.transaction(async tx=>{
      const bot=(await tx.query("SELECT id FROM bots WHERE id=$1 AND state<>'retired'",[input.botId])).rows[0];
      requireThat(bot,'Active recipient bot required');
      const rows=(await tx.query(`SELECT l.id,l.bot_id AS author_bot_id,l.content,l.evidence_id,l.reviewer,
        b.state AS author_state,e.source_id,e.published_at,e.received_at,o.url,o.observed_at,
        matched.terms AS matched_terms,cardinality(matched.terms) AS relevance
        FROM lessons l JOIN bots b ON b.id=l.bot_id JOIN evidence e ON e.id=l.evidence_id
        JOIN sources s ON s.id=e.source_id LEFT JOIN source_observations o ON o.evidence_id=e.id
        CROSS JOIN LATERAL (SELECT ARRAY(SELECT term FROM unnest($2::text[]) AS term
          WHERE strpos(lower(l.content),term)>0 ORDER BY term) AS terms) matched
        WHERE l.bot_id<>$1 AND l.status='verified' AND e.status='verified' AND s.approved
        AND e.published_at<=now() AND cardinality(matched.terms)>0
        ORDER BY cardinality(matched.terms) DESC,l.created_at DESC,l.id LIMIT $3`,[bot.id,terms,input.limit+1])).rows;
      const lessons=rows.slice(0,input.limit);
      return {botId:bot.id,terms,lessons,suggestedLessonIds:lessons.slice(0,5).map(l=>l.id),truncated:rows.length>input.limit,
        ranking:'distinct-substring-matches-v1',scope:'current-reviewed-cross-bot-lessons',
        warning:'Relevance is not confidence or demonstrated learning. Recheck support when requesting a transfer.',
        modelInvoked:false,fitnessChanged:false};
    });
  }
  request(actor:Actor,key:string,raw:unknown){
    permit(actor,'researcher');const input=parse(z.object({botId:id,task:short,lessonIds:z.array(z.uuid()).min(1).max(5).refine(a=>new Set(a).size===a.length)}).strict(),raw);
    return this.db.command(actor,'bot-knowledge-request',key,input,async tx=>{
      const policy=(await tx.query('SELECT * FROM development_policy WHERE id=1')).rows[0]!;
      requireThat(policy.enabled&&policy.model,'Enable an existing model profile in development policy first');
      requireThat(!(await tx.query('SELECT halted FROM system_lock WHERE id=1')).rows[0]!.halted,'System halted');
      const bot=(await tx.query("SELECT id,name,department,specialty,method,contribution FROM bots WHERE id=$1 AND state<>'retired'",[input.botId])).rows[0];
      requireThat(bot,'Active recipient bot required');
      const lessons=await lessonRows(tx,input.lessonIds);
      requireThat(lessons.some(l=>l.bot_id!==bot.id),'Cross-bot transfer requires another bot’s lesson');
      const counts=(await tx.query("SELECT count(*)::int AS total,count(*) FILTER(WHERE created_at>now()-interval '24 hours')::int AS daily FROM development_requests")).rows[0]!;
      requireThat(counts.total<policy.max_lifetime&&counts.daily<policy.max_per_day,'Shared development request capacity reached');
      const experiences=(await sharedResearchMemory(tx,undefined,bot.id)).slice(0,5);
      const priorPlans=(await tx.query(`SELECT k.request_id,p.proposal,result.report AS assessment FROM bot_knowledge_requests k
        JOIN bot_knowledge_proposals p ON p.request_id=k.request_id JOIN bot_knowledge_reviews r ON r.request_id=k.request_id
        JOIN development_requests d ON d.id=k.request_id
        LEFT JOIN knowledge_assessments a ON a.request_id=k.request_id LEFT JOIN knowledge_assessment_results result ON result.assessment_id=a.id
        WHERE k.bot_id=$1 AND r.decision='accepted' AND d.policy_revision=$2
        AND NOT EXISTS(SELECT 1 FROM bot_knowledge_lessons x JOIN lessons l ON l.id=x.lesson_id
          JOIN evidence e ON e.id=l.evidence_id JOIN sources s ON s.id=e.source_id WHERE x.request_id=k.request_id
          AND (l.status<>'verified' OR e.status<>'verified' OR NOT s.approved OR e.published_at>now()))
        ORDER BY r.created_at DESC,k.request_id LIMIT 5`,[bot.id,policy.revision])).rows;
      const context={kind:'knowledge-transfer-v1',bot,task:input.task,experiences,priorPlans,
        lessons:lessons.map(l=>({id:l.id,authorBotId:l.bot_id,content:l.content,evidenceId:l.evidence_id,
          provenance:{sourceId:l.source_id,publishedAt:new Date(l.published_at).toISOString(),receivedAt:new Date(l.received_at).toISOString(),
            articleUrl:l.article_url??null,title:l.article_title??null,observedAt:l.observed_at?new Date(l.observed_at).toISOString():null}}))};
      const requestId=uuid(),contextHash=digest(context);
      await assertTokenCapacity(tx,context);
      const saved=(await tx.query(`INSERT INTO development_requests(id,author,policy_revision,model,context,context_hash,expires_at)
        VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,now()+interval '10 minutes') RETURNING expires_at`,
        [requestId,actor.id,policy.revision,JSON.stringify(policy.model),JSON.stringify(context),contextHash])).rows[0]!;
      await tx.query('INSERT INTO bot_knowledge_requests VALUES($1,$2)',[requestId,bot.id]);
      for(const lesson of lessons)await tx.query('INSERT INTO bot_knowledge_lessons VALUES($1,$2)',[requestId,lesson.id]);
      await audit(tx,actor,'knowledge.transfer.requested',requestId,{botId:bot.id,lessonIds:input.lessonIds,contextHash});
      return {id:requestId,model:policy.model,context,contextHash,expiresAt:new Date(saved.expires_at).toISOString()};
    });
  }
  preflight(actor:Actor,raw:unknown){
    permit(actor,'researcher');const input=parse(z.object({requestId:z.uuid()}).strict(),raw);
    return this.db.transaction(async tx=>{const r=await this.load(tx,input.requestId);requireThat(r.author===actor.id&&r.fresh,'Current assigned request required');await active(tx,r);return {authorised:true};});
  }
  private async load(tx:Sql,requestId:string){
    const r=(await tx.query('SELECT d.*,k.bot_id,d.expires_at>now() AS fresh FROM development_requests d JOIN bot_knowledge_requests k ON k.request_id=d.id WHERE d.id=$1',[requestId])).rows[0];
    requireThat(r,'Knowledge request not found',404);return r;
  }
  submit(actor:Actor,key:string,raw:unknown){
    permit(actor,'researcher');const input=parse(z.object({requestId:z.uuid(),contextHash:z.string().regex(/^[a-f0-9]{64}$/),proposal:proposalSchema}).strict(),raw);
    return this.db.command(actor,'bot-knowledge-submit',key,input,async tx=>{
      const r=await this.load(tx,input.requestId);requireThat(r.author===actor.id&&r.fresh,'Current assigned request required');await active(tx,r);
      requireThat(r.context_hash===input.contextHash,'Knowledge context changed');
      requireThat(digest([...input.proposal.lessonIds].sort())===digest(r.context.lessons.map((l:Row)=>l.id).sort()),'Cite every supplied lesson exactly once');
      const old=(await tx.query('SELECT proposal FROM bot_knowledge_proposals WHERE request_id=$1',[r.id])).rows[0];
      if(old)requireThat(digest(old.proposal)===digest(input.proposal),'Knowledge proposal already fixed');
      else{await tx.query('INSERT INTO bot_knowledge_proposals(request_id,proposal) VALUES($1,$2::jsonb)',[r.id,JSON.stringify(input.proposal)]);
        await audit(tx,actor,'knowledge.transfer.proposed',r.id,{botId:r.bot_id});}
      return {requestId:r.id,state:'awaiting-review',demonstratedLearning:false};
    });
  }
  review(actor:Actor,key:string,raw:unknown){
    permit(actor,'evaluator');const input=parse(z.object({requestId:z.uuid(),decision:z.enum(['accepted','rejected']),reason:text}).strict(),raw);
    return this.db.command(actor,'bot-knowledge-review',key,input,async tx=>{
      const r=await this.load(tx,input.requestId);requireThat(r.author!==actor.id,'Independent reviewer required');
      requireThat((await tx.query('SELECT 1 FROM bot_knowledge_proposals WHERE request_id=$1',[r.id])).rows.length,'Submitted plan required');
      if(input.decision==='accepted')await active(tx,r);
      const old=(await tx.query('SELECT decision,reason FROM bot_knowledge_reviews WHERE request_id=$1',[r.id])).rows[0];
      if(old)requireThat(old.decision===input.decision&&old.reason===input.reason,'Knowledge review already fixed');
      else{await tx.query('INSERT INTO bot_knowledge_reviews VALUES($1,$2,$3,$4,now())',[r.id,actor.id,input.decision,input.reason]);
        await audit(tx,actor,'knowledge.transfer.'+input.decision,r.id,{botId:r.bot_id,reason:input.reason,demonstratedLearning:false});}
      return {requestId:r.id,decision:input.decision,demonstratedLearning:false,fitnessChanged:false};
    });
  }
  graph(actor:Actor,raw:unknown){
    permit(actor,'owner','evaluator');const input=parse(z.object({botId:id}).strict(),raw);
    return this.db.transaction(async tx=>{
      const bot=(await tx.query('SELECT id,name,department,specialty,method,state,mentor_id FROM bots WHERE id=$1',[input.botId])).rows[0];requireThat(bot,'Bot not found',404);
      const lessons=(await tx.query(`SELECT DISTINCT l.id,l.bot_id,l.content,l.evidence_id,e.source_id,e.kind,e.content_hash,
        (l.status='verified' AND e.status='verified' AND s.approved AND e.published_at<=now()) AS usable
        FROM lessons l JOIN evidence e ON e.id=l.evidence_id JOIN sources s ON s.id=e.source_id
        WHERE l.bot_id=$1 OR EXISTS(SELECT 1 FROM bot_curriculum c WHERE c.bot_id=$1 AND c.lesson_id=l.id)
        OR EXISTS(SELECT 1 FROM bot_knowledge_lessons x JOIN bot_knowledge_requests k ON k.request_id=x.request_id WHERE k.bot_id=$1 AND x.lesson_id=l.id)
        OR EXISTS(SELECT 1 FROM incident_learning_assignments a WHERE a.bot_id=$1 AND a.lesson_id=l.id)
        ORDER BY l.id LIMIT 101`,[bot.id])).rows;
      const transfers=(await tx.query(`SELECT k.request_id,p.proposal,r.decision,r.reason,r.reviewer,d.context_hash,a.id AS assessment_id,result.report AS assessment FROM bot_knowledge_requests k
        JOIN development_requests d ON d.id=k.request_id LEFT JOIN bot_knowledge_proposals p ON p.request_id=k.request_id
        LEFT JOIN bot_knowledge_reviews r ON r.request_id=k.request_id
        LEFT JOIN knowledge_assessments a ON a.request_id=k.request_id
        LEFT JOIN knowledge_assessment_results result ON result.assessment_id=a.id
        WHERE k.bot_id=$1 ORDER BY d.created_at DESC LIMIT 100`,[bot.id])).rows;
      const nodes=new Map<string,Row>(),edges:Row[]=[];
      nodes.set('bot:'+bot.id,{...bot,id:'bot:'+bot.id,type:'bot',botId:bot.id});
      for(const l of lessons.slice(0,100)){
        for(const n of [{id:'bot:'+l.bot_id,type:'bot',botId:l.bot_id},{id:'lesson:'+l.id,type:'lesson',content:l.content,usable:l.usable},
          {id:'evidence:'+l.evidence_id,type:'evidence',kind:l.kind,hash:l.content_hash},{id:'source:'+l.source_id,type:'source',sourceId:l.source_id}])if(!nodes.has(n.id))nodes.set(n.id,n);
        edges.push({from:'bot:'+l.bot_id,to:'lesson:'+l.id,type:'authored'},{from:'lesson:'+l.id,to:'evidence:'+l.evidence_id,type:'supported-by'},
          {from:'evidence:'+l.evidence_id,to:'source:'+l.source_id,type:'published-by'});
      }
      const observations=(await tx.query(`SELECT * FROM source_observations WHERE evidence_id=ANY($1::uuid[])`,[lessons.slice(0,100).map(l=>l.evidence_id)])).rows;
      const incidentLessons=(await tx.query(`SELECT il.lesson_id,f.id AS finding_id,f.incident_id,i.status,
        f.root_cause,f.corrective_action,f.prevention,f.verification_plan,r.decision
        FROM incident_lessons il JOIN incident_findings f ON f.id=il.finding_id
        JOIN incidents i ON i.id=f.incident_id JOIN incident_finding_reviews r ON r.finding_id=f.id
        WHERE il.lesson_id=ANY($1::uuid[])`,[lessons.slice(0,100).map(l=>l.id)])).rows;
      for(const finding of incidentLessons){
        nodes.set('incident:'+finding.incident_id,{id:'incident:'+finding.incident_id,type:'incident',status:finding.status});
        nodes.set('finding:'+finding.finding_id,{...finding,id:'finding:'+finding.finding_id,type:'incident-finding',remediationExecutionEstablished:false});
        edges.push({from:'incident:'+finding.incident_id,to:'finding:'+finding.finding_id,type:'investigated-through'},
          {from:'finding:'+finding.finding_id,to:'lesson:'+finding.lesson_id,type:'lesson-proposed-from'});
      }
      const assignments=(await tx.query(`SELECT id,lesson_id,task FROM incident_learning_assignments
        WHERE bot_id=$1 ORDER BY created_at DESC,id LIMIT 101`,[bot.id])).rows;
      for(const a of assignments.slice(0,100)){
        nodes.set('assignment:'+a.id,{id:'assignment:'+a.id,type:'incident-learning-assignment',task:a.task,incidentMasteryEstablished:false});
        edges.push({from:'assignment:'+a.id,to:'bot:'+bot.id,type:'assigned-to'});
        if(nodes.has('lesson:'+a.lesson_id))edges.push({from:'lesson:'+a.lesson_id,to:'assignment:'+a.id,type:'assigned-through'});
      }
      for(const o of observations){
        nodes.set('observation:'+o.evidence_id,{...o,id:'observation:'+o.evidence_id,type:'source-observation'});
        edges.push({from:'evidence:'+o.evidence_id,to:'observation:'+o.evidence_id,type:'observed-as'});
      }
      const extractions=(await tx.query(`SELECT p.*,r.decision,r.reason FROM source_learning_proposals p
        LEFT JOIN source_learning_reviews r ON r.request_id=p.request_id WHERE p.lesson_id=ANY($1::uuid[])`,[lessons.slice(0,100).map(l=>l.id)])).rows;
      for(const p of extractions){nodes.set('extraction:'+p.request_id,{...p,id:'extraction:'+p.request_id,type:'source-lesson-proposal'});
        edges.push({from:'lesson:'+p.lesson_id,to:'extraction:'+p.request_id,type:'extracted-through'});}
      for(const t of transfers){nodes.set('transfer:'+t.request_id,{id:'transfer:'+t.request_id,type:'transfer',...t,demonstratedLearning:false});
        if(t.assessment_id){nodes.set('assessment:'+t.assessment_id,{id:'assessment:'+t.assessment_id,type:'fresh-task-assessment',report:t.assessment??null});
          edges.push({from:'transfer:'+t.request_id,to:'assessment:'+t.assessment_id,type:'tested-by'});}
        if(t.reviewer){nodes.set('principal:'+t.reviewer,{id:'principal:'+t.reviewer,type:'reviewer'});edges.push({from:'transfer:'+t.request_id,to:'principal:'+t.reviewer,type:'reviewed-by'});}
        edges.push({from:'transfer:'+t.request_id,to:'bot:'+bot.id,type:t.decision==='accepted'?'reviewed-plan-for':'proposed-for'});
        for(const lessonId of t.proposal?.lessonIds??[])if(nodes.has('lesson:'+lessonId))edges.push({from:'lesson:'+lessonId,to:'transfer:'+t.request_id,type:'referenced-by'});
      }
      for(const memory of (await sharedResearchMemory(tx,undefined,bot.id)).slice(0,20)){
        nodes.set('memory:'+memory.id,{...memory,id:'memory:'+memory.id,type:'reviewed-experience'});
        nodes.set('trial:'+memory.trialId,{id:'trial:'+memory.trialId,type:'evaluated-trial'});
        edges.push({from:'bot:'+bot.id,to:'memory:'+memory.id,type:'experienced'},
          {from:'memory:'+memory.id,to:'trial:'+memory.trialId,type:'reflects'});
      }
      const attempts=(await tx.query('SELECT assignment_id,request_id FROM incident_learning_attempts WHERE assignment_id=ANY($1::uuid[])',[assignments.slice(0,100).map(a=>a.id)])).rows;
      for(const a of attempts)if(nodes.has('transfer:'+a.request_id))edges.push({from:'assignment:'+a.assignment_id,to:'transfer:'+a.request_id,type:'attempted-through'});
      return {nodes:[...nodes.values()],edges,truncated:lessons.length>100||assignments.length>100||transfers.length===100,scope:'current-knowledge-not-historical-backtest',demonstratedLearning:false};
    });
  }
}
