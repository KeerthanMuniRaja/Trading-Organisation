import test from 'node:test';
import assert from 'node:assert/strict';
import { importBatch,validateBatch } from './import-observations.mjs';
const row={sourceId:'fixture',url:'https://example.org/story',title:'Fixture',kind:'news',content:'Untrusted source text',publishedAt:'2025-01-01T00:00:00Z'};
const env={API_URL:'http://127.0.0.1:3000',PRINCIPALS_JSON:JSON.stringify([{role:'researcher',token:'fixture-token'}])};
test('importer scopes requests and replays the same key after a lost acknowledgement',async()=>{
  const calls=[];let fail=true;
  const transport=async(url,options)=>{calls.push({url,options});if(fail){fail=false;throw new Error('lost');}return {ok:true,json:async()=>({id:'fixture-id',status:'unverified'})};};
  await assert.rejects(()=>importBatch([row],env,transport),/Rerun the unchanged/);
  assert.equal((await importBatch([row],env,transport)).submitted,1);
  assert.deepEqual(calls[0].options.headers,calls[1].options.headers);assert.equal(calls[0].options.body,calls[1].options.body);
  assert.equal(calls[0].options.redirect,'error');assert.equal(calls[0].url.pathname,'/v1/sources/observations');
});
test('importer rejects invalid batches and origins before transmitting credentials',async()=>{
  for(const value of [[],Array(26).fill(row),[{...row,status:'verified'}],[{...row,content:'x'.repeat(4001)}],[{...row,url:'https://user:password@example.org'}]])assert.throws(()=>validateBatch(value));
  let calls=0;const transport=async()=>{calls++;throw new Error('unexpected');};
  for(const API_URL of ['http://example.org','https://user:password@example.org','https://example.org/api','https://example.org/?key=secret'])await assert.rejects(()=>importBatch([row],{...env,API_URL},transport));
  await assert.rejects(()=>importBatch([row,{...row,kind:'invalid'}],env,transport));assert.equal(calls,0);
});
