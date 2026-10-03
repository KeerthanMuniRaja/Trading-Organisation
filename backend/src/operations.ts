import { z } from 'zod';
import { Actor, digest, parse, permit, requireThat, text, uuid } from './core.js';
import { Database, audit } from './database.js';
import { verifiedEvidence } from './organisation.js';

export class Operations {
  constructor(private readonly db:Database) {}
  integrationStatus(actor:Actor,raw:unknown) {
    permit(actor,'coordinator');
    const input=parse(z.object({state:z.enum(['healthy','degraded']),code:z.enum(['SYNCED','OS_PROFILE_UNAVAILABLE','DEPENDENCIES_UNAVAILABLE','BACKEND_UNAVAILABLE','MCP_UNAVAILABLE','RECONCILIATION_REQUIRED','CAPACITY_REACHED']),taskCount:z.number().int().min(0).max(100)}).strict().refine(v=>(v.state==='healthy')===(v.code==='SYNCED'),'Health state and code must agree'),raw);
    return this.db.transaction(async tx=>{
      const previous=(await tx.query('SELECT state,code FROM coordination_health WHERE actor=$1',[actor.id])).rows[0];
      await tx.query('INSERT INTO coordination_health(actor,state,code,task_count) VALUES($1,$2,$3,$4) ON CONFLICT(actor) DO UPDATE SET state=EXCLUDED.state,code=EXCLUDED.code,task_count=EXCLUDED.task_count,last_seen=now()',[actor.id,input.state,input.code,input.taskCount]);
      if(!previous||previous.state!==input.state||previous.code!==input.code)await audit(tx,actor,'integration.ruflo.'+input.state,actor.id,input);
      return {recorded:true};
    });
  }
  incident(actor:Actor,key:string,raw:unknown) {
    permit(actor,'owner','researcher','evaluator','trader','treasury','market');const input=parse(z.object({description:text,severity:z.enum(['warning','critical'])}).strict(),raw);
    return this.db.command(actor,'incident',key,input,async tx=>{
      const incidentId=uuid();await tx.query("INSERT INTO incidents(id,reporter,description,severity,status) VALUES($1,$2,$3,$4,'open')",[incidentId,actor.id,input.description,input.severity]);
      if(input.severity==='critical')await tx.query('UPDATE system_lock SET halted=true,halt_reason=$1 WHERE id=1',[incidentId]);
      await audit(tx,actor,'incident.opened',incidentId,input);return {id:incidentId,status:'open',newRiskHalted:input.severity==='critical'};
    });
  }
  resolve(actor:Actor,key:string,raw:unknown) {
    permit(actor,'owner');const input=parse(z.object({incidentId:z.uuid(),evidenceId:z.uuid()}).strict(),raw);
    return this.db.command(actor,'resolve-incident',key,input,async tx=>{
      const incident=(await tx.query("SELECT * FROM incidents WHERE id=$1 AND status='open'",[input.incidentId])).rows[0];requireThat(incident,'Open incident not found',404);await verifiedEvidence(tx,input.evidenceId);
      await tx.query("UPDATE incidents SET status='resolved',resolution_evidence=$1 WHERE id=$2",[input.evidenceId,input.incidentId]);
      await audit(tx,actor,'incident.resolved',input.incidentId,input);return {id:input.incidentId,status:'resolved',resumeRequired:true};
    });
  }
  control(actor:Actor,key:string,raw:unknown) {
    permit(actor,'owner');const input=parse(z.object({halted:z.boolean(),reason:text}).strict(),raw);
    return this.db.command(actor,'operations-control',key,input,async tx=>{
      if(!input.halted)requireThat(!(await tx.query("SELECT id FROM incidents WHERE status='open' AND severity='critical'")).rows.length,'Resolve critical incidents before resuming');
      await tx.query('UPDATE system_lock SET halted=$1,halt_reason=$2 WHERE id=1',[input.halted,input.reason]);await audit(tx,actor,'operations.control.changed','organisation',input);return input;
    });
  }
  status(actor:Actor) {
    permit(actor,'owner');return this.db.transaction(async tx=>({
      mode:'paper',control:(await tx.query('SELECT halted,halt_reason FROM system_lock')).rows[0],
      integrations:(await tx.query('SELECT actor,state,code,task_count,last_seen FROM coordination_health ORDER BY actor')).rows,
      incidents:(await tx.query('SELECT * FROM incidents ORDER BY created_at DESC LIMIT 100')).rows,
      jobs:(await tx.query('SELECT id,kind,state,attempts,lease_until FROM jobs ORDER BY id LIMIT 100')).rows,
      notifications:(await tx.query('SELECT * FROM notifications WHERE acknowledged_at IS NULL ORDER BY created_at DESC LIMIT 200')).rows,
    }));
  }
  acknowledge(actor:Actor,key:string,raw:unknown) {
    permit(actor,'owner');const input=parse(z.object({notificationId:z.uuid()}).strict(),raw);
    return this.db.command(actor,'acknowledge',key,input,async tx=>{
      const updated=await tx.query('UPDATE notifications SET acknowledged_at=now() WHERE id=$1 RETURNING id',[input.notificationId]);requireThat(updated.rows.length,'Notification not found',404);return {id:input.notificationId,acknowledged:true};
    });
  }
  auditTrail(actor:Actor) {
    permit(actor,'owner');return this.db.transaction(async tx=>(await tx.query('SELECT * FROM audit_events ORDER BY sequence DESC LIMIT 500')).rows);
  }
  verifyAudit(actor:Actor) {
    permit(actor,'owner');return this.db.transaction(async tx=>{
      const rows=(await tx.query('SELECT * FROM audit_events ORDER BY sequence')).rows;let previous='GENESIS';
      for(const row of rows) {
        const hash=digest({id:row.id,actor:row.actor,action:row.action,entity:row.entity,payload:row.payload,previous});
        requireThat(row.previous_hash===previous&&row.hash===hash,'Audit chain integrity check failed');previous=row.hash;
      }
      return {valid:true,events:rows.length,head:previous};
    });
  }
}
