import { Actor, permit } from './core.js';
import { Database } from './database.js';
import { availableResearchDatasets, curriculumStatus } from './research-eligibility.js';
import { hasOpenBotWork } from './lifecycle-history.js';
import { departmentSnapshot } from './department-sessions.js';
import { schoolSkillReady } from './skills.js';
import { schoolSkillBudget } from './skill-recovery.js';

const advice:Record<string,string>={
  SYSTEM_HALTED:'Review open incidents and the halt reason. Only the owner may resume.',
  LIFECYCLE_DISABLED:'Review lifecycle policy before explicitly enabling admissions and assessment.',
  DISPATCH_DISABLED:'Review the dataset pool and dispatch policy before explicitly enabling research.',
  CURRICULUM_MISSING:'Provide independently reviewed curriculum before progressing this student.',
  CURRICULUM_INVALID:'Review revoked lesson evidence; do not reuse unsupported lessons.',
  SCHOOL_PENDING:'An eligible lifecycle cycle must admit this student to college.',
  SKILL_ASSESSMENT_REQUIRED:'Complete the current research-basics exam and independent evaluation before college admission.',
  SKILL_ATTEMPTS_EXHAUSTED:'Review exam history and a new corrective lesson. Only the owner can authorise one bounded recovery attempt when eligible.',
  RETIREMENT_PENDING:'Drain submitted trials; a lifecycle cycle cancels unfinished assignments and archives when safe.',
  LEASE_EXPIRED:'An evaluator dispatch cycle or researcher claim must reconcile this expired lease.',
  ASSIGNMENT_INELIGIBLE:'Run a dispatch reconciliation; the pending assignment no longer has valid support.',
  RESEARCH_QUEUED:'A researcher worker must claim this existing assignment.',
  RESEARCH_RUNNING:'A lease is outstanding. This is not proof that the worker process is alive.',
  EVALUATION_PENDING:'An independent evaluator must review the submitted trial or the owner must cancel it.',
  DATASET_POOL_EMPTY:'Register and explicitly approve example datasets for dispatch.',
  NO_FRESH_WINDOWS:'Review source validity and add approved non-overlapping example windows if appropriate.',
  DAILY_ASSIGNMENT_CAP:'Wait for the rolling 24-hour allowance; do not reset historical counters.',
  LIFETIME_ASSIGNMENT_CAP:'The owner must review the lifetime limit before further allocation.',
};

export class OrganisationReport {
  constructor(private readonly db:Database) {}

  snapshot(actor:Actor) {
    permit(actor,'owner');
    return this.db.transaction(async tx=>{
      const instant=(await tx.query('SELECT now() AS instant')).rows[0]!.instant;
      const generatedAt=new Date(instant).toISOString(),now=Date.parse(generatedAt);
      const control=(await tx.query('SELECT halted,halt_reason FROM system_lock WHERE id=1')).rows[0]!;
      const lifecycle=(await tx.query('SELECT revision,rules,last_cycle_at FROM lifecycle_policy WHERE id=1')).rows[0]!;
      const skillPolicy=(await tx.query('SELECT revision,enabled FROM skill_policy WHERE id=1')).rows[0]!;
      const dispatch=(await tx.query('SELECT revision,rules FROM research_dispatch_policy WHERE id=1')).rows[0]!;
      const usage=(await tx.query(`SELECT count(*)::int AS lifetime,
        count(*) FILTER(WHERE created_at>now()-interval '24 hours')::int AS rolling_day
        FROM research_assignments`)).rows[0]!;
      const remaining={daily:Math.max(0,dispatch.rules.maxAssignmentsPerDay-usage.rolling_day),
        lifetime:Math.max(0,dispatch.rules.maxLifetimeAssignments-usage.lifetime)};
      const globalCodes:string[]=[];
      if(control.halted)globalCodes.push('SYSTEM_HALTED');
      if(!lifecycle.rules.enabled)globalCodes.push('LIFECYCLE_DISABLED');
      if(!dispatch.rules.enabled)globalCodes.push('DISPATCH_DISABLED');
      const bots=(await tx.query(`SELECT b.id,b.name,b.state,b.specialty,b.method,l.designation,l.reputation,l.retirement_pending,
        l.born_at,l.retired_at FROM bots b JOIN bot_lifecycle l ON l.bot_id=b.id
        WHERE b.lifecycle_managed=true ORDER BY l.born_at,b.id LIMIT 100`)).rows;
      const students=[];
      for(const bot of bots){
        const skillBudget=bot.state==='school'&&skillPolicy.enabled?await schoolSkillBudget(tx,bot.id,skillPolicy.revision):null;
        const curriculum=await curriculumStatus(tx,bot.id);
        const work=(await tx.query(`SELECT a.id,a.state,a.attempts,a.lease_until,
          (e.status='verified' AND s.approved=true) AS evidence_active
          FROM research_assignments a JOIN portfolio_datasets d ON d.id=a.dataset_id
          JOIN evidence e ON e.id=d.evidence_id JOIN sources s ON s.id=e.source_id
          WHERE a.bot_id=$1 AND a.state IN ('queued','running') ORDER BY a.created_at,a.id LIMIT 100`,[bot.id])).rows;
        const awaiting=(await tx.query("SELECT count(*)::int AS count FROM portfolio_trials WHERE bot_id=$1 AND state='submitted'",[bot.id])).rows[0]!.count as number;
        const fresh=bot.state==='college'&&!bot.retirement_pending
          ?(await availableResearchDatasets(tx,bot.id,dispatch.rules.datasetIds)).length:0;
        const codes:string[]=[];
        if(bot.state!=='retired'){
          codes.push(...globalCodes);
          if(bot.retirement_pending)codes.push('RETIREMENT_PENDING');
          else {
            if(!curriculum.lessonCount)codes.push('CURRICULUM_MISSING');
            else if(!curriculum.valid)codes.push('CURRICULUM_INVALID');
            if(bot.state==='school'){
              if(!await schoolSkillReady(tx,bot.id)){
                if(skillBudget&&!skillBudget.baseRemaining&&!skillBudget.recoveryAvailable&&!skillBudget.awaitingOutcome)codes.push('SKILL_ATTEMPTS_EXHAUSTED');
                codes.push('SKILL_ASSESSMENT_REQUIRED');
              }
              codes.push('SCHOOL_PENDING');
            }
          }
          for(const assignment of work){
            if(!assignment.evidence_active||!curriculum.valid)codes.push('ASSIGNMENT_INELIGIBLE');
            if(assignment.state==='running'&&new Date(assignment.lease_until).getTime()<=now)codes.push('LEASE_EXPIRED');
            else codes.push(assignment.state==='queued'?'RESEARCH_QUEUED':'RESEARCH_RUNNING');
          }
          if(awaiting)codes.push('EVALUATION_PENDING');
          if(bot.state==='college'&&!bot.retirement_pending&&!work.length&&!awaiting){
            if(!dispatch.rules.datasetIds.length)codes.push('DATASET_POOL_EMPTY');
            else if(!fresh)codes.push('NO_FRESH_WINDOWS');
            if(!remaining.daily)codes.push('DAILY_ASSIGNMENT_CAP');
            if(!remaining.lifetime)codes.push('LIFETIME_ASSIGNMENT_CAP');
          }
        }
        const canAssignNow=bot.state==='college'&&codes.length===0;
        students.push({id:bot.id,name:bot.name,specialty:bot.specialty,method:bot.method,state:bot.state,
          designation:bot.designation,reputation:bot.reputation,retirementPending:bot.retirement_pending,
          canAssignNow,readyToArchive:bot.retirement_pending&&!globalCodes.includes('SYSTEM_HALTED')&&lifecycle.rules.enabled&&!(await hasOpenBotWork(tx,bot.id)),
          curriculum,skillBudget,availableWindowCount:fresh,pendingEvaluations:awaiting,
          assignments:work.map(a=>({id:a.id,state:a.state,attempts:a.attempts,leaseUntil:a.lease_until})),
          reasons:[...new Set(codes)].map(code=>({code,message:advice[code]})),
          nextAction:bot.state==='retired'?'History is preserved; no new research is assigned.'
            :canAssignNow?'An evaluator dispatch cycle can allocate research within the remaining shared budget.'
            :advice[codes[0]!]??'Inspect lifecycle records.',
        });
      }
      const population=(await tx.query(`SELECT count(*)::int AS lifetime,count(*) FILTER(WHERE b.state<>'retired')::int AS active,
        count(*) FILTER(WHERE l.born_at>now()-interval '24 hours')::int AS rolling_day_births
        FROM bot_lifecycle l JOIN bots b ON b.id=l.bot_id`)).rows[0]!;
      const blueprints=(await tx.query('SELECT state,count(*)::int AS count FROM lifecycle_blueprints GROUP BY state ORDER BY state')).rows;
      const lastCycle=lifecycle.last_cycle_at?new Date(lifecycle.last_cycle_at).toISOString():null;
      const nextCycle=lastCycle?new Date(Date.parse(lastCycle)+lifecycle.rules.cycleSeconds*1000).toISOString():null;
      const workers=await departmentSnapshot(tx);
      return {
        generatedAt,scope:'example-research-only',mode:'paper',liveTradingEnabled:false,
        summary:{managedStudents:students.length,readyForAssignment:students.filter(b=>b.canAssignNow).length,
          awaitingEvaluation:students.reduce((n,b)=>n+b.pendingEvaluations,0),retired:students.filter(b=>b.state==='retired').length},
        control,blockers:globalCodes.map(code=>({code,message:advice[code]})),
        lifecycle:{revision:lifecycle.revision,enabled:lifecycle.rules.enabled,lastCycleAt:lastCycle,nextEligibleCycleAt:nextCycle,
          cooldownRemainingSeconds:nextCycle?Math.max(0,Math.ceil((Date.parse(nextCycle)-now)/1000)):0,population,blueprints,
          admissionSlots:Math.max(0,Math.min(lifecycle.rules.maxActiveBots-population.active,
            lifecycle.rules.maxLifetimeBots-population.lifetime,lifecycle.rules.maxBirthsPerDay-population.rolling_day_births)),
          note:'Slots do not certify a blueprint: admission rechecks evidence, curriculum, novelty and policy.'},
        dispatch:{revision:dispatch.revision,enabled:dispatch.rules.enabled,approvedDatasetCount:dispatch.rules.datasetIds.length,
          used:usage,remaining,counts:(await tx.query('SELECT state,count(*)::int AS count FROM research_assignments GROUP BY state ORDER BY state')).rows},
        students,
        recentAssignmentFailures:(await tx.query("SELECT id,bot_id,reason,attempts,created_at FROM research_assignments WHERE state='failed' ORDER BY created_at DESC,id LIMIT 20")).rows,
        notifications:{unreadCount:(await tx.query('SELECT count(*)::int AS count FROM notifications WHERE acknowledged_at IS NULL')).rows[0]!.count,
          latest:(await tx.query('SELECT id,summary,created_at FROM notifications WHERE acknowledged_at IS NULL ORDER BY created_at DESC,id LIMIT 20')).rows},
        workerLiveness:workers.status,workers,
        learning:{policy:(await tx.query('SELECT revision,enabled,model_id,max_per_day,max_lifetime FROM learning_policy WHERE id=1')).rows[0],
          counts:(await tx.query(`SELECT count(*)::int AS proposals,count(*) FILTER(WHERE r.proposal_id IS NULL)::int AS pending,
            count(*) FILTER(WHERE r.decision='verified')::int AS historically_verified
            FROM learning_proposals p LEFT JOIN learning_reviews r ON r.proposal_id=p.id`)).rows[0]},
        development:{policy:(await tx.query('SELECT revision,enabled,model,max_per_day,max_lifetime FROM development_policy WHERE id=1')).rows[0],
          requests:(await tx.query('SELECT count(*)::int AS count FROM development_requests')).rows[0]!.count,
          experiments:(await tx.query(`SELECT count(*)::int AS registered,
            count(*) FILTER(WHERE r.experiment_id IS NULL AND c.experiment_id IS NULL)::int AS pending,
            count(*) FILTER(WHERE r.outcome='supported-for-further-research')::int AS historically_supported,
            count(*) FILTER(WHERE r.outcome='not-supported')::int AS not_supported,
            count(*) FILTER(WHERE c.experiment_id IS NOT NULL)::int AS cancelled
            FROM development_experiments x LEFT JOIN development_experiment_results r ON r.experiment_id=x.id
            LEFT JOIN development_experiment_cancellations c ON c.experiment_id=x.id`)).rows[0]},
        limitations:['This read-only snapshot does not run workers, reconcile leases or acknowledge notifications.',
          'Readiness is a snapshot and does not reserve a shared budget or promise admission.',
          'Reputation and example portfolio results are not demonstrated trading skill or realised profit.'],
      };
    });
  }
}
