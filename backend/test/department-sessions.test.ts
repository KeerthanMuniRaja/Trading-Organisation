import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DepartmentSessions } from '../src/department-sessions.js';
import { OrganisationReport } from '../src/organisation-report.js';
import { fixture,owner,researcher,evaluator } from './helpers.js';

test('department roles have one current supervisor each and owner-only read-only status',async()=>{
  const f=await fixture();try{
    const service=new DepartmentSessions(f.db),sessionId=randomUUID();
    assert.equal((await service.status(owner)).status,'not-observed');
    assert.throws(()=>service.start(owner,{sessionId}),/not permitted/);
    assert.throws(()=>service.status(researcher),/not permitted/);
    const first=await service.start(researcher,{sessionId});
    const repeated=await service.start(researcher,{sessionId});assert.equal(first.leaseUntil,repeated.leaseUntil);
    await assert.rejects(()=>service.start(researcher,{sessionId:randomUUID()}),/already holds/);
    await assert.rejects(()=>service.start({id:'another-researcher',role:'researcher'},{sessionId}),/another principal/);
    await service.start(evaluator,{sessionId:randomUUID()});
    const before=await f.ops.verifyAudit(owner);
    assert.equal((await service.status(owner)).status,'responding');
    assert.equal((await new OrganisationReport(f.db).snapshot(owner)).workerLiveness,'responding');
    assert.deepEqual(await f.ops.verifyAudit(owner),before);
  }finally{await f.db.close();}
});

test('ordered heartbeat retries do not extend freshness or allow rewritten counters',async()=>{
  const f=await fixture();try{
    const service=new DepartmentSessions(f.db),sessionId=randomUUID();
    await service.start(researcher,{sessionId});
    const body={sessionId,sequence:1,state:'running',completedCycles:0,failedCycles:0};
    const first=await service.heartbeat(researcher,body),events=await f.ops.verifyAudit(owner);
    const replay=await service.heartbeat(researcher,body);assert.equal(replay.leaseUntil,first.leaseUntil);
    assert.deepEqual(await f.ops.verifyAudit(owner),events);
    await assert.rejects(()=>service.heartbeat(researcher,{...body,state:'waiting'}),/Sequence reused/);
    await assert.rejects(()=>service.heartbeat(researcher,{...body,sequence:3}),/out of order/);
    await assert.rejects(()=>service.heartbeat(researcher,{...body,sequence:2,completedCycles:3}),/at most once/);
    await assert.rejects(()=>service.heartbeat(evaluator,body),/Current supervisor/);
    await service.heartbeat(researcher,{...body,sequence:2,state:'waiting',completedCycles:1});
    await assert.rejects(()=>service.heartbeat(researcher,{...body,sequence:3}),/at most once/);
  }finally{await f.db.close();}
});

test('expired sessions cannot renew or replace their successor; stopped sessions cannot restart',async()=>{
  const f=await fixture();try{
    const service=new DepartmentSessions(f.db),sessionId=randomUUID();
    await service.start(researcher,{sessionId});
    await f.db.transaction(tx=>tx.query("UPDATE department_sessions SET lease_until=now()-interval '1 second' WHERE role='researcher'"));
    const before=await f.ops.verifyAudit(owner);
    assert.equal((await service.status(owner)).workers.find(w=>w.role==='researcher')!.status,'stale');
    assert.deepEqual(await f.ops.verifyAudit(owner),before);
    await assert.rejects(()=>service.heartbeat(researcher,{sessionId,sequence:1,state:'running',completedCycles:0,failedCycles:0}),/has ended/);
    await assert.rejects(()=>service.start(researcher,{sessionId}),/has ended/);
    const next=randomUUID();await service.start(researcher,{sessionId:next});
    await assert.rejects(()=>service.heartbeat(researcher,{sessionId,sequence:1,state:'stopped',completedCycles:0,failedCycles:0}),/Current supervisor/);
    const stopped={sessionId:next,sequence:1,state:'stopped',completedCycles:0,failedCycles:0};
    await service.heartbeat(researcher,stopped);await service.heartbeat(researcher,stopped);
    await assert.rejects(()=>service.start(researcher,{sessionId}),/previous session/);
    await assert.rejects(()=>service.start(researcher,{sessionId:next}),/has ended/);
    assert.equal((await service.status(owner)).workers.find(w=>w.role==='researcher')!.status,'stopped');
  }finally{await f.db.close();}
});

test('failure and recovery notify on changes, and running alone does not clear a failed cycle',async()=>{
  const f=await fixture();try{
    const service=new DepartmentSessions(f.db),sessionId=randomUUID();await service.start(researcher,{sessionId});
    const original=(await f.ops.verifyAudit(owner)).events;
    await service.heartbeat(researcher,{sessionId,sequence:1,state:'degraded',completedCycles:0,failedCycles:1});
    await service.heartbeat(researcher,{sessionId,sequence:2,state:'degraded',completedCycles:0,failedCycles:2});
    await service.heartbeat(researcher,{sessionId,sequence:3,state:'running',completedCycles:0,failedCycles:2});
    assert.equal((await service.status(owner)).workers.find(w=>w.role==='researcher')!.status,'degraded');
    assert.equal((await f.ops.verifyAudit(owner)).events,original+1);
    await service.heartbeat(researcher,{sessionId,sequence:4,state:'waiting',completedCycles:1,failedCycles:2});
    assert.equal((await service.status(owner)).workers.find(w=>w.role==='researcher')!.status,'responding');
    assert.equal((await f.ops.verifyAudit(owner)).events,original+2);
    assert.equal((await f.treasury.snapshot(owner)).wallet1Paise,'0');
  }finally{await f.db.close();}
});
