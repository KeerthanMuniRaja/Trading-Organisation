import { z } from 'zod';
import { Actor, parse, permit, requireThat, text, uuid } from './core.js';
import { Database, audit } from './database.js';
import { verifiedEvidence } from './organisation.js';
import { reconcileAssignments } from './dispatch-state.js';
import { availableResearchDatasets } from './research-eligibility.js';

const rulesSchema=z.object({enabled:z.boolean(),maxAssignmentsPerDay:z.number().int().min(1).max(100),
  maxLifetimeAssignments:z.number().int().min(1).max(1000),
  datasetIds:z.array(z.uuid()).max(100).refine(v=>new Set(v).size===v.length,'Duplicate dataset')}).strict();

export class ResearchDispatch {
  constructor(private readonly db:Database) {}

  configure(actor:Actor,key:string,raw:unknown) {
    permit(actor,'owner');const input=parse(z.object({expectedRevision:z.number().int().min(0),rules:rulesSchema}).strict(),raw);
    requireThat(!input.rules.enabled||input.rules.datasetIds.length>0,'Approve datasets before enabling dispatch',400);
    return this.db.command(actor,'dispatch-policy',key,input,async tx=>{
      const policy=(await tx.query('SELECT revision FROM research_dispatch_policy WHERE id=1')).rows[0]!;
      requireThat(policy.revision===input.expectedRevision,'Dispatch policy revision changed');
      for(const datasetId of input.rules.datasetIds){
        const dataset=(await tx.query("SELECT evidence_id FROM portfolio_datasets WHERE id=$1 AND purpose='example-testing'",[datasetId])).rows[0];
        requireThat(dataset,'Approved example dataset required',400);
        // The owner must be able to pause even after an approved source is revoked.
        if(input.rules.enabled)await verifiedEvidence(tx,dataset.evidence_id);
      }
      const revision=policy.revision+1;
      await tx.query('UPDATE research_dispatch_policy SET revision=$1,rules=$2::jsonb WHERE id=1',[revision,JSON.stringify(input.rules)]);
      // Remove withdrawn work. Disabling blocks execution; existing lease clocks still expire.
      const pending=(await tx.query("SELECT id,dataset_id FROM research_assignments WHERE state IN ('queued','running')")).rows;
      for(const assignment of pending)if(!input.rules.datasetIds.includes(assignment.dataset_id)){
        await tx.query("UPDATE research_assignments SET state='cancelled',reason='Dataset removed from dispatch policy',lease_owner=NULL,lease_token=NULL,lease_until=NULL WHERE id=$1",[assignment.id]);
        await audit(tx,actor,'research.assignment.cancelled',assignment.id,{reason:'Dataset removed from dispatch policy'});
      }
      await audit(tx,actor,'research.dispatch.policy.changed','research-dispatch',{revision,rules:input.rules});
      return {revision,rules:input.rules};
    });
  }

  cycle(actor:Actor,key:string,raw:unknown) {
    permit(actor,'owner','evaluator');const input=parse(z.object({}).strict(),raw);
    return this.db.command(actor,'dispatch-cycle',key,input,async tx=>{
      await reconcileAssignments(tx,actor);
      const policy=(await tx.query('SELECT * FROM research_dispatch_policy WHERE id=1')).rows[0]!;
      const rules=parse(rulesSchema,policy.rules);
      const life=(await tx.query('SELECT rules FROM lifecycle_policy WHERE id=1')).rows[0]!;
      if(!rules.enabled||!life.rules.enabled)return {status:'disabled',assignments:[]};
      if((await tx.query('SELECT halted FROM system_lock WHERE id=1')).rows[0]!.halted)return {status:'halted',assignments:[]};
      const counts=(await tx.query(`SELECT count(*)::int AS total,count(*) FILTER(WHERE created_at>now()-interval '24 hours')::int AS recent FROM research_assignments`)).rows[0]!;
      let remaining=Math.min(rules.maxLifetimeAssignments-counts.total,rules.maxAssignmentsPerDay-counts.recent);
      const assignments:string[]=[];
      // Least-recently assigned students go first, including students that have no work yet.
      const bots=(await tx.query(`SELECT b.id,b.method FROM bots b JOIN bot_lifecycle l ON l.bot_id=b.id
        WHERE b.lifecycle_managed=true AND b.state='college' AND l.retirement_pending=false
        AND EXISTS(SELECT 1 FROM bot_curriculum c WHERE c.bot_id=b.id)
        AND NOT EXISTS(SELECT 1 FROM bot_curriculum c JOIN lessons x ON x.id=c.lesson_id
          JOIN evidence e ON e.id=x.evidence_id JOIN sources s ON s.id=e.source_id
          WHERE c.bot_id=b.id AND (x.status<>'verified' OR e.status<>'verified' OR s.approved=false))
        AND NOT EXISTS(SELECT 1 FROM research_assignments a WHERE a.bot_id=b.id AND a.state IN ('queued','running'))
        AND NOT EXISTS(SELECT 1 FROM portfolio_trials t WHERE t.bot_id=b.id AND t.state='submitted')
        ORDER BY (SELECT max(a.created_at) FROM research_assignments a WHERE a.bot_id=b.id) ASC NULLS FIRST,b.id LIMIT 100`)).rows;
      for(const bot of bots){
        if(remaining<=0)break;
        // Never allocate an overlapping holdout again, including failed/cancelled work.
        const datasets=await availableResearchDatasets(tx,bot.id,rules.datasetIds,1);
        if(!datasets.length)continue;
        const assignmentId=uuid(),datasetId=datasets[0]!.id;
        await tx.query("INSERT INTO research_assignments(id,bot_id,dataset_id,method,policy_revision,state) VALUES($1,$2,$3,$4,$5,'queued')",[assignmentId,bot.id,datasetId,bot.method,policy.revision]);
        await audit(tx,actor,'research.assignment.queued',assignmentId,{botId:bot.id,datasetId,method:bot.method,policyRevision:policy.revision});
        assignments.push(assignmentId);remaining--;
      }
      return {status:'completed',assignments,scope:'example-research-only'};
    });
  }

  claim(actor:Actor,key:string,raw:unknown) {
    permit(actor,'researcher');const input=parse(z.object({}).strict(),raw);
    return this.db.command(actor,'dispatch-claim',key,input,async tx=>{
      await reconcileAssignments(tx,actor);
      const policy=(await tx.query('SELECT rules FROM research_dispatch_policy WHERE id=1')).rows[0]!;
      const life=(await tx.query('SELECT rules FROM lifecycle_policy WHERE id=1')).rows[0]!;
      if(!policy.rules.enabled||!life.rules.enabled)return {status:'disabled',assignment:null};
      if((await tx.query('SELECT halted FROM system_lock WHERE id=1')).rows[0]!.halted)return {status:'halted',assignment:null};
      const row=(await tx.query("SELECT * FROM research_assignments WHERE state='queued' ORDER BY created_at,id LIMIT 1")).rows[0];
      if(!row)return {status:'idle',assignment:null};
      const token=uuid();
      const claimed=(await tx.query(`UPDATE research_assignments SET state='running',attempts=attempts+1,lease_owner=$2,lease_token=$3,
        lease_until=now()+interval '120 seconds',reason=NULL WHERE id=$1 RETURNING lease_until`,[row.id,actor.id,token])).rows[0]!;
      await audit(tx,actor,'research.assignment.claimed',row.id,{attempt:row.attempts+1});
      return {status:'claimed',assignment:{id:row.id,botId:row.bot_id,datasetId:row.dataset_id,method:row.method,leaseToken:token,leaseUntil:new Date(claimed.lease_until).toISOString()}};
    });
  }

  reviews(actor:Actor) {
    permit(actor,'evaluator');return this.db.transaction(async tx=>({
      trials:(await tx.query(`SELECT t.id AS "trialId" FROM research_assignments a JOIN portfolio_trials t ON t.id=a.trial_id
        JOIN portfolio_datasets d ON d.id=t.dataset_id JOIN evidence e ON e.id=d.evidence_id JOIN sources s ON s.id=e.source_id
        JOIN bots b ON b.id=t.bot_id WHERE a.state='submitted' AND t.state='submitted' AND t.author<>$1
        AND b.state='college' AND e.status='verified' AND s.approved=true ORDER BY t.created_at,t.id LIMIT 10`,[actor.id])).rows,
    }));
  }

  cancel(actor:Actor,key:string,raw:unknown) {
    permit(actor,'owner');const input=parse(z.object({assignmentId:z.uuid(),reason:text}).strict(),raw);
    return this.db.command(actor,'dispatch-cancel',key,input,async tx=>{
      requireThat((await tx.query(`UPDATE research_assignments SET state='cancelled',reason=$2,lease_owner=NULL,lease_token=NULL,lease_until=NULL
        WHERE id=$1 AND state IN ('queued','running') RETURNING id`,[input.assignmentId,input.reason])).rows.length,'Only pending assignments can be cancelled');
      await audit(tx,actor,'research.assignment.cancelled',input.assignmentId,{reason:input.reason});return {state:'cancelled'};
    });
  }

  status(actor:Actor) {
    permit(actor,'owner','evaluator');return this.db.transaction(async tx=>({
      policy:(await tx.query('SELECT revision,rules FROM research_dispatch_policy WHERE id=1')).rows[0],
      assignments:(await tx.query(`SELECT a.id,a.bot_id,a.dataset_id,a.method,a.state,a.attempts,a.reason,a.trial_id,a.created_at,t.state AS trial_state
        FROM research_assignments a LEFT JOIN portfolio_trials t ON t.id=a.trial_id ORDER BY a.created_at DESC,a.id LIMIT 100`)).rows,
      counts:(await tx.query('SELECT state,count(*)::int AS count FROM research_assignments GROUP BY state')).rows,
      scope:'example-research-only',
    }));
  }
}
