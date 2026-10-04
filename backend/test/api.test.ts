import test from 'node:test';
import assert from 'node:assert/strict';
import { sign } from 'node:crypto';
import { createApp } from '../src/app.js';
import { Database } from '../src/database.js';
import { config,key } from './helpers.js';
import { loadConfig } from '../src/config.js';

test('HTTP boundary authenticates, authorizes, validates and signs owner transactions',async()=>{
  const {cfg,privateKey}=config(),db=await Database.open(),app=await createApp(cfg,db,true);
  try {
    await app.listen(0,'127.0.0.1');const base=await app.getUrl();
    const call=(path:string,role?:string,body?:unknown)=>fetch(base+'/v1'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key(),...(role?{Authorization:'Bearer '+cfg.principals.find(p=>p.role===role)!.token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    assert.equal((await call('/health')).status,200);
    assert.equal((await call('/treasury')).status,401);
    assert.equal((await call('/treasury','trader')).status,403);
    assert.equal((await call('/treasury/allocations','researcher',{})).status,403);
    assert.equal((await call('/coordination/tasks','coordinator')).status,200);
    assert.equal((await call('/treasury','coordinator')).status,403);
    assert.equal((await call('/experiments','coordinator')).status,403);
    assert.equal((await call('/sources','owner',{id:'x',name:'X',url:'https://example.org',approved:true,permissions:['admin']})).status,400);
    const request={action:'deposit',payload:{amountPaise:'10000',bankReference:'http-deposit'}};
    const challengeResponse=await call('/owner/challenges','owner',request);assert.equal(challengeResponse.status,201);
    const challenge=await challengeResponse.json() as any;
    const proof={challengeId:challenge.challengeId,signature:sign(null,Buffer.from(challenge.message),privateKey).toString('base64url')};
    assert.equal((await call('/owner/transactions','owner',{request,proof})).status,201);
    assert.equal((await call('/owner/transactions','owner',{request,proof})).status,403);
    const balance=await call('/treasury','owner');assert.equal(balance.headers.get('cache-control'),'no-store');assert.ok(balance.headers.get('x-content-type-options'));
    const snapshot=await balance.json() as any;assert.equal(snapshot.wallet1Paise,'10000');assert.equal(snapshot.wallet2Paise,'0');
    assert.throws(()=>loadConfig({APP_MODE:'live'}),/must explicitly be paper/);
  }finally{await app.close();await db.close();}
});
