import { z } from 'zod';
import { Actor, id, parse, permit, requireThat, text, uuid } from './core.js';
import { Database, Row, Sql, audit } from './database.js';
import { verifiedEvidence } from './organisation.js';
import { portfolioMethod } from './portfolio.js';
import { archiveResearchBot, hasOpenBotWork } from './lifecycle-history.js';
import { cancelAssignments } from './dispatch-state.js';
import { schoolSkillReady } from './skills.js';

const rulesSchema=z.object({enabled:z.boolean(),maxActiveBots:z.number().int().min(1).max(10),
  maxBirthsPerDay:z.number().int().min(1).max(5),maxLifetimeBots:z.number().int().min(1).max(100),
  minWindows:z.number().int().min(3).max(10),reviewsBeforeRetirement:z.number().int().min(3).max(10),
  mentorReviews:z.number().int().min(3).max(10),positiveRewardBps:z.number().finite().min(1).max(10000),
  negativeRewardBps:z.number().finite().min(-10000).max(-1),cycleSeconds:z.number().int().min(60).max(3600)}).strict();
type Rules=z.infer<typeof rulesSchema>;
type Period={start:number;end:number};
const period=(r:Row):Period=>({start:Date.parse(r.holdout[0].timestamp),end:Date.parse(r.holdout.at(-1).timestamp)});
const overlaps=(a:Period,b:Period)=>a.start<=b.end&&b.start<=a.end;

async function validLessons(tx:Sql,lessonIds:string[]) {
  const lessons=[];
  for(const lessonId of lessonIds){
    const lesson=(await tx.query(`SELECT l.* FROM lessons l JOIN evidence e ON e.id=l.evidence_id
      JOIN sources s ON s.id=e.source_id WHERE l.id=$1 AND l.status='verified' AND e.status='verified' AND s.approved=true`,[lessonId])).rows[0];
    if(!lesson)return null;lessons.push(lesson);
  }
  return lessons;
}

export class ResearchLifecycle {
  constructor(private readonly db:Database) {}

  configure(actor:Actor,key:string,raw:unknown) {
    permit(actor,'owner');const input=parse(z.object({expectedRevision:z.number().int().min(0),rules:rulesSchema}).strict(),raw);
    requireThat(input.rules.maxActiveBots<=input.rules.maxLifetimeBots,'Active cap exceeds lifetime cap',400);
    return this.db.command(actor,'lifecycle-policy',key,input,async tx=>{
      const old=(await tx.query('SELECT revision FROM lifecycle_policy WHERE id=1')).rows[0]!;
      requireThat(old.revision===input.expectedRevision,'Lifecycle policy revision changed');
      const revision=old.revision+1;
      await tx.query('UPDATE lifecycle_policy SET revision=$1,rules=$2::jsonb WHERE id=1',[revision,JSON.stringify(input.rules)]);
      await audit(tx,actor,'lifecycle.policy.changed','research-lifecycle',{revision,rules:input.rules,scope:'example-research-only'});
      return {revision,rules:input.rules};
    });
  }

  blueprint(actor:Actor,key:string,raw:unknown) {
    permit(actor,'owner');const input=parse(z.object({id,name:text,specialty:id,method:portfolioMethod,contribution:text,
      evidenceId:z.uuid(),lessonIds:z.array(z.uuid()).min(1).max(10).refine(v=>new Set(v).size===v.length,'Duplicate lesson'),mentorId:id.optional()}).strict(),raw);
    return this.db.command(actor,'lifecycle-blueprint',key,input,async tx=>{
      await verifiedEvidence(tx,input.evidenceId);
      requireThat(await validLessons(tx,input.lessonIds),'Reviewed curriculum with active evidence required');
      if(input.mentorId)requireThat((await tx.query('SELECT id FROM bots WHERE id=$1',[input.mentorId])).rows.length,'Mentor identity not found');
      requireThat(Number((await tx.query('SELECT count(*) AS count FROM lifecycle_blueprints')).rows[0]!.count)<100,'Blueprint registry capacity reached');
      const novelty=['research',input.specialty,input.method].map(v=>v.toLowerCase()).join(':');
      requireThat(!(await tx.query('SELECT id FROM bots WHERE novelty_key=$1 UNION ALL SELECT id FROM lifecycle_blueprints WHERE novelty_key=$1',[novelty])).rows.length,'Declared capability already exists');
      await tx.query("INSERT INTO lifecycle_blueprints(id,name,specialty,method,novelty_key,contribution,evidence_id,lesson_ids,mentor_id,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,'approved')",
        [input.id,input.name,input.specialty,input.method,novelty,input.contribution,input.evidenceId,JSON.stringify(input.lessonIds),input.mentorId??null]);
      await audit(tx,actor,'lifecycle.blueprint.approved',input.id,{...input,scope:'example-research-only'});
      return {id:input.id,state:'approved'};
    });
  }

  withdraw(actor:Actor,key:string,raw:unknown) {
    permit(actor,'owner');const input=parse(z.object({blueprintId:id,reason:text}).strict(),raw);
    return this.db.command(actor,'lifecycle-withdraw',key,input,async tx=>{
      requireThat((await tx.query("UPDATE lifecycle_blueprints SET state='withdrawn' WHERE id=$1 AND state='approved' RETURNING id",[input.blueprintId])).rows.length,'Blueprint is not awaiting admission');
      await audit(tx,actor,'lifecycle.blueprint.withdrawn',input.blueprintId,{reason:input.reason});return {id:input.blueprintId,state:'withdrawn'};
    });
  }

  private async assess(tx:Sql,actor:Actor,bot:Row,policy:Row,rules:Rules) {
    // Every counted period is disjoint from all periods already used for this bot.
    // Revocation never frees an old assessment for a second reward.
    const consumed=(await tx.query(`SELECT d.holdout FROM lifecycle_review_trials rt JOIN portfolio_trials t ON t.id=rt.trial_id
      JOIN portfolio_datasets d ON d.id=t.dataset_id WHERE t.bot_id=$1`,[bot.bot_id])).rows.map(period);
    const candidates=(await tx.query(`SELECT t.id,t.report,d.holdout FROM portfolio_trials t
      JOIN portfolio_datasets d ON d.id=t.dataset_id JOIN evidence e ON e.id=d.evidence_id JOIN sources s ON s.id=e.source_id
      WHERE t.bot_id=$1 AND t.method=$2 AND t.state='evaluated' AND d.purpose='example-testing'
      AND e.status='verified' AND s.approved=true
      AND NOT EXISTS(SELECT 1 FROM lifecycle_review_trials rt WHERE rt.trial_id=t.id)
      ORDER BY d.holdout->0->>'timestamp',t.id LIMIT 500`,[bot.bot_id,bot.method])).rows;
    const selected:Row[]=[];
    for(const trial of candidates){
      if(trial.report.calculatedBy!=='backend'||trial.report.promotionAllowed!==false||!Number.isFinite(trial.report.rewardBps))continue;
      const current=period(trial);
      if(consumed.some(p=>overlaps(p,current)))continue;
      selected.push(trial);consumed.push(current);
      if(selected.length===rules.minWindows)break;
    }
    if(selected.length<rules.minWindows)return null;
    const mean=selected.reduce((total,t)=>total+t.report.rewardBps,0)/selected.length;
    const outcome=mean>=rules.positiveRewardBps?'positive':mean<=rules.negativeRewardBps?'negative':'neutral';
    const reviewId=uuid(),details={scope:'example-research-only',method:bot.method,trials:selected.map(t=>t.id),windows:selected.length,
      explanation:'Relative portfolio research reward, not money, live fitness or trading permission.'};
    await tx.query('INSERT INTO lifecycle_reviews(id,bot_id,policy_revision,policy,outcome,mean_reward_bps,details) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb)',
      [reviewId,bot.bot_id,policy.revision,JSON.stringify(rules),outcome,mean,JSON.stringify(details)]);
    for(const trial of selected)await tx.query('INSERT INTO lifecycle_review_trials VALUES($1,$2)',[trial.id,reviewId]);
    await audit(tx,actor,'lifecycle.performance.reviewed',bot.bot_id,{reviewId,outcome,meanRewardBps:mean,...details});
    return {id:reviewId,outcome};
  }

  private async fitness(tx:Sql,botId:string,revision:number,rules:Rules) {
    const history=(await tx.query(`SELECT r.outcome,NOT EXISTS(SELECT 1 FROM lifecycle_review_trials rt JOIN portfolio_trials t ON t.id=rt.trial_id
        JOIN portfolio_datasets d ON d.id=t.dataset_id JOIN evidence e ON e.id=d.evidence_id JOIN sources s ON s.id=e.source_id
        WHERE rt.review_id=r.id AND (e.status<>'verified' OR s.approved=false)) AS valid
      FROM lifecycle_reviews r WHERE r.bot_id=$1 AND r.policy_revision=$2
      ORDER BY r.created_at,r.id`,[botId,revision])).rows;
    let positive=0,negative=0,reputation=0;
    for(const review of history){
      if(!review.valid){positive=0;negative=0;continue;}
      positive=review.outcome==='positive'?positive+1:0;negative=review.outcome==='negative'?negative+1:0;
      reputation=Math.max(-100,Math.min(100,reputation+(review.outcome==='positive'?10:review.outcome==='negative'?-10:0)));
    }
    return {reputation,positive,negative,designation:positive>=rules.mentorReviews?'mentor':history.length?'practising':'student',pending:negative>=rules.reviewsBeforeRetirement};
  }

  cycle(actor:Actor,key:string,raw:unknown) {
    permit(actor,'evaluator','owner');const input=parse(z.object({}).strict(),raw);
    return this.db.command(actor,'lifecycle-cycle',key,input,async tx=>{
      const policy=(await tx.query('SELECT * FROM lifecycle_policy WHERE id=1')).rows[0]!;
      const rules=parse(rulesSchema,policy.rules);
      if(!rules.enabled)return {status:'disabled',actions:[]};
      if((await tx.query('SELECT halted FROM system_lock WHERE id=1')).rows[0]!.halted)return {status:'halted',actions:[]};
      if(policy.last_cycle_at&&Date.now()-new Date(policy.last_cycle_at).getTime()<rules.cycleSeconds*1000)return {status:'cooldown',actions:[]};
      await tx.query('UPDATE lifecycle_policy SET last_cycle_at=now() WHERE id=1');
      const actions:Record<string,unknown>[]=[];
      const students=(await tx.query(`SELECT l.*,b.state,b.method FROM bot_lifecycle l JOIN bots b ON b.id=l.bot_id
        WHERE b.lifecycle_managed=true AND b.state<>'retired' ORDER BY l.born_at,l.bot_id LIMIT 100`)).rows;
      for(const bot of students){
        if(bot.state==='school'){
          const curriculum=(await tx.query('SELECT lesson_id FROM bot_curriculum WHERE bot_id=$1',[bot.bot_id])).rows.map(r=>r.lesson_id as string);
          if(curriculum.length&&await validLessons(tx,curriculum)&&await schoolSkillReady(tx,bot.bot_id)){
            await tx.query("UPDATE bots SET state='college' WHERE id=$1",[bot.bot_id]);
            await audit(tx,actor,'lifecycle.school.completed',bot.bot_id,{curriculum,scope:'example-research-only'});
            actions.push({botId:bot.bot_id,action:'college-admission'});
          }
          continue;
        }
        const review=await this.assess(tx,actor,bot,policy,rules);
        if(review)actions.push({botId:bot.bot_id,action:'performance-review',reviewId:review.id,outcome:review.outcome});
        const fitness=await this.fitness(tx,bot.bot_id,policy.revision,rules);
        if(bot.reputation!==fitness.reputation||bot.designation!==fitness.designation||bot.retirement_pending!==fitness.pending||bot.negative_streak!==fitness.negative||bot.positive_streak!==fitness.positive){
          await tx.query('UPDATE bot_lifecycle SET reputation=$1,designation=$2,positive_streak=$3,negative_streak=$4,retirement_pending=$5 WHERE bot_id=$6',
            [fitness.reputation,fitness.designation,fitness.positive,fitness.negative,fitness.pending,bot.bot_id]);
          await audit(tx,actor,'lifecycle.fitness.updated',bot.bot_id,{...fitness,policyRevision:policy.revision,scope:'example-research-only'});
        }
        if(fitness.pending)await cancelAssignments(tx,actor,bot.bot_id,'Student is closing work for retirement');
        if(fitness.pending&&!(await hasOpenBotWork(tx,bot.bot_id))){
          await archiveResearchBot(tx,actor,bot.bot_id,'Repeated negative example-research assessments under owner policy revision '+policy.revision);
          actions.push({botId:bot.bot_id,action:'archived'});
        }
      }
      const counts=(await tx.query(`SELECT count(*)::int AS total,
        count(*) FILTER(WHERE b.state<>'retired')::int AS active,
        count(*) FILTER(WHERE l.born_at>now()-interval '24 hours')::int AS recent
        FROM bot_lifecycle l JOIN bots b ON b.id=l.bot_id`)).rows[0]!;
      if(counts.active<rules.maxActiveBots&&counts.total<rules.maxLifetimeBots&&counts.recent<rules.maxBirthsPerDay){
        const blueprints=(await tx.query("SELECT * FROM lifecycle_blueprints WHERE state='approved' ORDER BY created_at,id LIMIT 100")).rows;
        for(const blueprint of blueprints){
          const evidence=(await tx.query("SELECT e.id FROM evidence e JOIN sources s ON s.id=e.source_id WHERE e.id=$1 AND e.status='verified' AND s.approved=true",[blueprint.evidence_id])).rows[0];
          const lessons=await validLessons(tx,blueprint.lesson_ids);
          const duplicate=(await tx.query('SELECT id FROM bots WHERE novelty_key=$1',[blueprint.novelty_key])).rows.length;
          if(!evidence||!lessons||duplicate){
            await tx.query("UPDATE lifecycle_blueprints SET state='blocked' WHERE id=$1",[blueprint.id]);
            await audit(tx,actor,'lifecycle.blueprint.blocked',blueprint.id,{reason:duplicate?'Declared capability exists':'Evidence or curriculum is no longer valid'});continue;
          }
          const botId='student-'+uuid();
          await tx.query("INSERT INTO bots(id,name,department,specialty,method,novelty_key,contribution,state,budget_paise,mentor_id,lifecycle_managed) VALUES($1,$2,'research',$3,$4,$5,$6,'school',0,$7,true)",
            [botId,blueprint.name,blueprint.specialty,blueprint.method,blueprint.novelty_key,blueprint.contribution,blueprint.mentor_id]);
          for(const lesson of lessons)await tx.query('INSERT INTO bot_curriculum VALUES($1,$2)',[botId,lesson.id]);
          await tx.query("INSERT INTO bot_lifecycle(bot_id,blueprint_id,designation) VALUES($1,$2,'student')",[botId,blueprint.id]);
          await tx.query("UPDATE lifecycle_blueprints SET state='used' WHERE id=$1",[blueprint.id]);
          await audit(tx,actor,'lifecycle.bot.born',botId,{blueprintId:blueprint.id,mentorId:blueprint.mentor_id,lessonIds:blueprint.lesson_ids,budgetPaise:'0',scope:'example-research-only'});
          actions.push({botId,action:'born'});break;
        }
      }
      return {status:'completed',policyRevision:policy.revision,scope:'example-research-only',actions};
    });
  }

  status(actor:Actor) {
    permit(actor,'owner','evaluator');return this.db.transaction(async tx=>({
      policy:(await tx.query('SELECT revision,rules,last_cycle_at FROM lifecycle_policy WHERE id=1')).rows[0],
      blueprints:(await tx.query('SELECT * FROM lifecycle_blueprints ORDER BY created_at DESC LIMIT 100')).rows,
      students:(await tx.query('SELECT l.*,b.name,b.specialty,b.method,b.state FROM bot_lifecycle l JOIN bots b ON b.id=l.bot_id ORDER BY l.born_at DESC LIMIT 100')).rows,
      reviews:(await tx.query('SELECT * FROM lifecycle_reviews ORDER BY created_at DESC,id LIMIT 200')).rows,
      scope:'example-research-only',workerRequired:true,
    }));
  }

  archives(actor:Actor) {
    permit(actor,'owner','evaluator');return this.db.transaction(async tx=>(await tx.query('SELECT * FROM bot_archives ORDER BY created_at DESC LIMIT 100')).rows);
  }

  community(actor:Actor) {
    permit(actor,'owner','researcher','evaluator');return this.db.transaction(async tx=>(await tx.query(`SELECT b.id,b.name,b.specialty,b.method,b.contribution,b.state,b.mentor_id,
      l.designation,l.reputation,l.retirement_pending FROM bot_lifecycle l JOIN bots b ON b.id=l.bot_id ORDER BY l.born_at LIMIT 100`)).rows);
  }
}
