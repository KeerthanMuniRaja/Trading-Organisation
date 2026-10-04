import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { fixture,owner,key } from './helpers.js';

test('Ruflo reports failure and recovery once without gaining financial or halt authority',async()=>{
  const f=await fixture(),app=await createApp(f.cfg,f.db,true);
  try {
    await app.listen(0,'127.0.0.1');const base=await app.getUrl();
    const call=(role:string,path:string,body:unknown)=>fetch(base+'/v1'+path,{method:'POST',headers:{Authorization:'Bearer '+f.cfg.principals.find(p=>p.role===role)!.token,'Content-Type':'application/json','Idempotency-Key':key()},body:JSON.stringify(body)});
    const failure={state:'degraded',code:'OS_PROFILE_UNAVAILABLE',taskCount:0};
    assert.equal((await call('researcher','/coordination/status',failure)).status,403);
    assert.equal((await call('coordinator','/coordination/status',{...failure,message:'untrusted text'})).status,400);
    assert.equal((await call('coordinator','/coordination/status',{...failure,state:'healthy'})).status,400);
    for(let i=0;i<2;i++)assert.equal((await call('coordinator','/coordination/status',failure)).status,201);
    let status=await f.ops.status(owner);
    assert.equal(status.integrations[0]!.code,'OS_PROFILE_UNAVAILABLE');
    assert.equal(status.notifications.filter(n=>n.summary.startsWith('integration.ruflo.')).length,1);
    assert.equal((await call('coordinator','/operations/control',{halted:false,reason:'attempt'})).status,403);
    assert.equal((await call('coordinator','/owner/challenges',{action:'deposit',payload:{amountPaise:'10000',bankReference:'test-reference'}})).status,403);
    assert.equal((await call('coordinator','/treasury/allocations',{})).status,403);
    assert.equal((await call('coordinator','/coordination/status',{state:'healthy',code:'SYNCED',taskCount:1})).status,201);
    status=await f.ops.status(owner);
    assert.equal(status.integrations[0]!.state,'healthy');
    assert.equal(status.notifications.filter(n=>n.summary.startsWith('integration.ruflo.')).length,2);
    assert.equal(status.control!.halted,false);
    const balances=await f.treasury.snapshot(owner);assert.equal(balances.wallet1Paise,'0');assert.equal(balances.wallet2Paise,'0');
  }finally{await app.close();await f.db.close();}
});
