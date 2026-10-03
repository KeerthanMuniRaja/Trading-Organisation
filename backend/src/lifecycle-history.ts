import { Actor, requireThat } from './core.js';
import { Sql, audit } from './database.js';

export async function hasOpenBotWork(tx:Sql,botId:string) {
  const result=await tx.query(`SELECT (
    EXISTS(SELECT 1 FROM orders WHERE bot_id=$1 AND status='reserved') OR
    EXISTS(SELECT 1 FROM positions WHERE bot_id=$1 AND quantity>0) OR
    EXISTS(SELECT 1 FROM portfolio_trials WHERE bot_id=$1 AND state='submitted') OR
    EXISTS(SELECT 1 FROM research_assignments WHERE bot_id=$1 AND state IN ('queued','running')) OR
    EXISTS(SELECT 1 FROM jobs j JOIN experiments e ON e.id=j.experiment_id
      WHERE e.bot_id=$1 AND j.state IN ('queued','running'))
  ) AS busy`,[botId]);
  return Boolean(result.rows[0]!.busy);
}

export async function archiveResearchBot(tx:Sql,actor:Actor,botId:string,reason:string) {
  const bot=(await tx.query('SELECT * FROM bots WHERE id=$1 AND lifecycle_managed=true',[botId])).rows[0];
  requireThat(bot,'Only managed research students may be archived by lifecycle rules');
  requireThat(!(await hasOpenBotWork(tx,botId)),'Resolve open work before lifecycle retirement');
  const existing=(await tx.query('SELECT bot_id FROM bot_archives WHERE bot_id=$1',[botId])).rows[0];
  if(existing)return;
  // All original tables remain. The archive links every experiment/review and
  // snapshots lessons with their current validity, never certifying failures as truth.
  const lessons=(await tx.query(`SELECT l.*,e.status AS evidence_status,s.approved AS source_approved
    FROM lessons l JOIN evidence e ON e.id=l.evidence_id JOIN sources s ON s.id=e.source_id
    WHERE l.bot_id=$1 OR l.id IN (SELECT lesson_id FROM bot_curriculum WHERE bot_id=$1)
    ORDER BY l.created_at,l.id`,[botId])).rows;
  const trials=(await tx.query('SELECT id,state,method FROM portfolio_trials WHERE bot_id=$1 ORDER BY created_at,id',[botId])).rows;
  const reviews=(await tx.query('SELECT id,outcome,policy_revision FROM lifecycle_reviews WHERE bot_id=$1 ORDER BY created_at,id',[botId])).rows;
  const assignments=(await tx.query('SELECT id,state,attempts,reason,trial_id FROM research_assignments WHERE bot_id=$1 ORDER BY created_at,id',[botId])).rows;
  const knowledge={identity:{id:bot.id,name:bot.name,specialty:bot.specialty,method:bot.method,contribution:bot.contribution,mentorId:bot.mentor_id},
    lessons,trials,reviews,assignments,historyRetained:true,warning:'Historical observations and failed experiments are not automatically verified lessons. Recheck current source validity before reuse.'};
  await tx.query('INSERT INTO bot_archives(bot_id,reason,knowledge) VALUES($1,$2,$3::jsonb)',[botId,reason,JSON.stringify(knowledge)]);
  await tx.query("UPDATE bots SET state='retired' WHERE id=$1",[botId]);
  await tx.query("UPDATE bot_lifecycle SET designation='retired',retirement_pending=false,retired_at=now() WHERE bot_id=$1",[botId]);
  await audit(tx,actor,'lifecycle.bot.archived',botId,{reason,lessons:lessons.length,trials:trials.length,reviews:reviews.length,historyRetained:true});
}
