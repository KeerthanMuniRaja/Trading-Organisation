import { z } from 'zod';
import { Actor, digest, parse, permit, requireThat } from './core.js';
import { Database, Row, Sql, audit } from './database.js';

const leaseSeconds=90;
function receipt(row:Row,now:Date) {
  return {sessionId:row.session_id,sequence:row.sequence,state:row.state,
    leaseUntil:new Date(row.lease_until).toISOString(),remainingSeconds:Math.max(0,Math.floor((new Date(row.lease_until).getTime()-now.getTime())/1000))};
}

export async function departmentSnapshot(tx:Sql) {
  const now=new Date((await tx.query('SELECT clock_timestamp() AS instant')).rows[0]!.instant);
  const rows=(await tx.query('SELECT * FROM department_sessions ORDER BY role')).rows;
  const workers=['researcher','evaluator'].map(role=>{
    const row=rows.find(r=>r.role===role);
    if(!row)return {role,status:'not-observed',sessionId:null,actor:null,phase:null,lastSeen:null,leaseUntil:null,
      lastCycleAt:null,completedCycles:0,failedCycles:0};
    const status=row.state==='stopped'?'stopped':new Date(row.lease_until)<=now?'stale':row.failure_active?'degraded':'responding';
    return {role,status,sessionId:row.session_id as string,actor:row.actor as string,phase:row.state as string,
      lastSeen:new Date(row.last_seen).toISOString(),leaseUntil:new Date(row.lease_until).toISOString(),
      lastCycleAt:row.last_cycle_at?new Date(row.last_cycle_at).toISOString():null,
      completedCycles:row.completed_cycles as number,failedCycles:row.failed_cycles as number};
  });
  const status=workers.every(w=>w.status==='not-observed')?'not-observed':workers.every(w=>w.status==='responding')?'responding'
    :workers.some(w=>w.status==='stale'||w.status==='degraded')?'attention-required':'partial-or-stopped';
  return {status,workers,leaseSeconds,scope:'department-supervisors',
    limitation:'Authenticated supervisor reports, not proof of useful work or process health. Staleness is calculated when read; no background stale-alert service.'};
}

export class DepartmentSessions {
  constructor(private readonly db:Database) {}
  start(actor:Actor,raw:unknown) {
    permit(actor,'researcher','evaluator');const input=parse(z.object({sessionId:z.uuid()}).strict(),raw);
    return this.db.transaction(async tx=>{
      const now=new Date((await tx.query('SELECT clock_timestamp() AS instant')).rows[0]!.instant);
      const current=(await tx.query('SELECT * FROM department_sessions WHERE role=$1',[actor.role])).rows[0];
      if(current?.session_id===input.sessionId){
        requireThat(current.actor===actor.id,'Session belongs to another principal',403);
        requireThat(current.state!=='stopped'&&new Date(current.lease_until)>now,'Session has ended; start a new session');
        return receipt(current,now); // A replay never extends the lease.
      }
      requireThat(!current||current.state==='stopped'||new Date(current.lease_until)<=now,'Another supervisor already holds this department role');
      requireThat(!(await tx.query('SELECT session_id FROM department_session_history WHERE session_id=$1',[input.sessionId])).rows.length,'A previous session cannot be restarted');
      if(current&&current.state!=='stopped')await audit(tx,actor,'department.session.expired',current.session_id,{role:actor.role,previousActor:current.actor,
        completedCycles:current.completed_cycles,failedCycles:current.failed_cycles,lastSeen:new Date(current.last_seen).toISOString()});
      await tx.query('INSERT INTO department_session_history(session_id,role,actor,created_at) VALUES($1,$2,$3,clock_timestamp())',[input.sessionId,actor.role,actor.id]);
      const row=(await tx.query(`INSERT INTO department_sessions(role,actor,session_id,state,last_seen,lease_until)
        VALUES($1,$2,$3,'waiting',clock_timestamp(),clock_timestamp()+interval '90 seconds') ON CONFLICT(role) DO UPDATE SET
        actor=EXCLUDED.actor,session_id=EXCLUDED.session_id,sequence=0,fingerprint=NULL,state='waiting',
        completed_cycles=0,failed_cycles=0,failure_active=false,last_cycle_at=NULL,last_seen=clock_timestamp(),lease_until=EXCLUDED.lease_until RETURNING *`,[actor.role,actor.id,input.sessionId])).rows[0]!;
      await audit(tx,actor,'department.session.started',input.sessionId,{role:actor.role,leaseSeconds});
      return receipt(row,now);
    });
  }
  heartbeat(actor:Actor,raw:unknown) {
    permit(actor,'researcher','evaluator');const input=parse(z.object({sessionId:z.uuid(),sequence:z.number().int().min(1).max(1000000),
      state:z.enum(['running','waiting','degraded','stopped']),completedCycles:z.number().int().min(0).max(10000),failedCycles:z.number().int().min(0).max(10000)}).strict(),raw);
    return this.db.transaction(async tx=>{
      const now=new Date((await tx.query('SELECT clock_timestamp() AS instant')).rows[0]!.instant);
      const old=(await tx.query('SELECT * FROM department_sessions WHERE role=$1',[actor.role])).rows[0];
      requireThat(old&&old.actor===actor.id&&old.session_id===input.sessionId,'Current supervisor session required',403);
      const hash=digest(input);
      if(input.sequence===old.sequence){
        requireThat(hash===old.fingerprint,'Sequence reused with different heartbeat');
        return receipt(old,now); // Lost acknowledgements are recoverable, without freshness inflation.
      }
      requireThat(old.state!=='stopped'&&new Date(old.lease_until)>now,'Session has ended; start a new session');
      requireThat(input.sequence===old.sequence+1,'Heartbeat sequence is out of order');
      const passed=input.completedCycles-old.completed_cycles,failed=input.failedCycles-old.failed_cycles;
      requireThat(passed>=0&&failed>=0&&passed+failed<=1,'Cycle counters must advance at most once per heartbeat');
      const failureActive=failed>0?true:passed>0?false:old.failure_active;
      requireThat(input.state!=='degraded'||failureActive,'Degraded phase requires an unresolved failed cycle');
      const row=(await tx.query(`UPDATE department_sessions SET sequence=$2,fingerprint=$3,state=$4,completed_cycles=$5,failed_cycles=$6,
        failure_active=$7,last_seen=clock_timestamp(),lease_until=CASE WHEN $4='stopped' THEN clock_timestamp() ELSE clock_timestamp()+interval '90 seconds' END,
        last_cycle_at=CASE WHEN $8 THEN clock_timestamp() ELSE last_cycle_at END WHERE role=$1 RETURNING *`,
        [actor.role,input.sequence,hash,input.state,input.completedCycles,input.failedCycles,failureActive,passed+failed>0])).rows[0]!;
      if(failed>0&&!old.failure_active)await audit(tx,actor,'department.cycle.degraded',input.sessionId,{role:actor.role,failedCycles:input.failedCycles});
      if(passed>0&&old.failure_active)await audit(tx,actor,'department.cycle.recovered',input.sessionId,{role:actor.role,completedCycles:input.completedCycles});
      if(input.state==='stopped')await audit(tx,actor,'department.session.stopped',input.sessionId,{role:actor.role,completedCycles:input.completedCycles,failedCycles:input.failedCycles});
      return receipt(row,now);
    });
  }
  status(actor:Actor) {permit(actor,'owner');return this.db.transaction(departmentSnapshot);}
}
