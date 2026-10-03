import { Actor } from './core.js';
import { Sql, audit } from './database.js';

// Called inside the caller's transaction; never opens a nested transaction.
export async function cancelAssignments(tx:Sql,actor:Actor,botId:string,reason:string) {
  const changed=(await tx.query(`UPDATE research_assignments SET state='cancelled',reason=$2,
    lease_owner=NULL,lease_token=NULL,lease_until=NULL WHERE bot_id=$1 AND state IN ('queued','running') RETURNING id`,[botId,reason])).rows;
  for(const row of changed)await audit(tx,actor,'research.assignment.cancelled',row.id,{botId,reason});
}

export async function reconcileAssignments(tx:Sql,actor:Actor) {
  const invalid=(await tx.query(`SELECT a.id FROM research_assignments a
    JOIN bots b ON b.id=a.bot_id JOIN bot_lifecycle l ON l.bot_id=b.id
    JOIN portfolio_datasets d ON d.id=a.dataset_id JOIN evidence e ON e.id=d.evidence_id JOIN sources s ON s.id=e.source_id
    WHERE a.state IN ('queued','running') AND (b.state<>'college' OR l.retirement_pending=true
      OR e.status<>'verified' OR s.approved=false
      OR NOT EXISTS(SELECT 1 FROM bot_curriculum c WHERE c.bot_id=b.id)
      OR EXISTS(SELECT 1 FROM bot_curriculum c JOIN lessons x ON x.id=c.lesson_id
        JOIN evidence ce ON ce.id=x.evidence_id JOIN sources cs ON cs.id=ce.source_id
        WHERE c.bot_id=b.id AND (x.status<>'verified' OR ce.status<>'verified' OR cs.approved=false)))`)).rows;
  for(const row of invalid){
    await tx.query("UPDATE research_assignments SET state='cancelled',reason='Eligibility or evidence withdrawn',lease_owner=NULL,lease_token=NULL,lease_until=NULL WHERE id=$1",[row.id]);
    await audit(tx,actor,'research.assignment.cancelled',row.id,{reason:'Eligibility or evidence withdrawn'});
  }
  const expired=(await tx.query("SELECT id,attempts FROM research_assignments WHERE state='running' AND lease_until<=now()")).rows;
  for(const row of expired){
    const state=row.attempts>=3?'failed':'queued';
    await tx.query('UPDATE research_assignments SET state=$2,reason=$3,lease_owner=NULL,lease_token=NULL,lease_until=NULL WHERE id=$1',
      [row.id,state,state==='failed'?'Three lease attempts exhausted':'Lease expired; retry available']);
    await audit(tx,actor,'research.assignment.'+state,row.id,{reason:'Worker lease expired',attempts:row.attempts});
  }
}
