import test from 'node:test';
import assert from 'node:assert/strict';
import { DepartmentSession, supervisorTransport } from './department-session.mjs';

const ack=body=>({sessionId:body.sessionId,sequence:body.sequence??0,remainingSeconds:body.state==='stopped'?0:89});

test('uncertain heartbeat acknowledgement retries the exact sequence and body',async()=>{
  const calls=[];let lost=false;
  const session=new DepartmentSession(async(route,body)=>{
    calls.push({route,body:structuredClone(body)});
    if(body.sequence===1&&!lost){lost=true;throw new Error('Lost acknowledgement');}
    return ack(body);
  },{heartbeatMs:0});
  await session.start();await session.pulse({state:'waiting',completedCycles:1});
  assert.deepEqual(calls[1],calls[2]);assert.equal(session.sequence,1);
  await session.stop();assert.equal(calls.at(-1).body.sequence,2);assert.equal(calls.at(-1).body.state,'stopped');
});

test('queued pulses preserve order and carry the latest acknowledged counters',async()=>{
  const calls=[];
  const session=new DepartmentSession(async(_route,body)=>{calls.push(structuredClone(body));return ack(body);},{heartbeatMs:0});
  await session.start();
  await Promise.all([session.pulse({state:'running'}),session.pulse({state:'degraded',failedCycles:1}),session.pulse()]);
  assert.deepEqual(calls.slice(1).map(b=>b.sequence),[1,2,3]);assert.equal(calls[3].failedCycles,1);
  await session.stop();await assert.rejects(()=>session.pulse(),/closing/);
});

test('a denied heartbeat aborts the supervisor and never tries to acquire a replacement session',async()=>{
  let loss=0,requests=0;
  const session=new DepartmentSession(async(route,body)=>{
    requests++;
    if(route.endsWith('heartbeats')){const error=new Error('Denied');error.retryable=false;throw error;}
    return ack(body);
  },{heartbeatMs:0,onLost:()=>loss++});
  await session.start();await assert.rejects(()=>session.pulse(),/Denied/);await session.stop();
  assert.equal(loss,1);assert.equal(requests,2);assert.equal(session.lost,true);
});

test('old lease acknowledgements and insecure origins cannot start supervised work',async()=>{
  const session=new DepartmentSession(async(_route,body)=>({...ack(body),remainingSeconds:0}),{heartbeatMs:0});
  await assert.rejects(()=>session.start(),/not current/);assert.equal(session.active,false);
  assert.throws(()=>supervisorTransport({API_URL:'http://example.org',API_TOKEN:'hidden'}),/Invalid/);
  assert.throws(()=>supervisorTransport({API_URL:'https://secret@example.org',API_TOKEN:'hidden'}),/Invalid/);
});
