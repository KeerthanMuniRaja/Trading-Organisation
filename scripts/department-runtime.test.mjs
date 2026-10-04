import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runDepartment } from './department-runtime.mjs';

// Exercise actual direct-child termination without Python, API, credentials or
// a trading database. Node executes this temporary .py-named fixture as JS.
async function childFixture() {
  const directory=await mkdtemp(path.join(tmpdir(),'organisation-child-'));
  await writeFile(path.join(directory,'department.py'),
    "require('node:fs').writeFileSync('started.json',JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);\n");
  return {
    directory,
    async started(){
      const deadline=Date.now()+15000;
      while(Date.now()<deadline){
        try{return JSON.parse(await readFile(path.join(directory,'started.json'),'utf8'));}
        catch(error){if(error.code!=='ENOENT')throw error;}
        await delay(100);
      }
      throw new Error('Direct child did not start');
    },
    async close(){
      for(const name of ['started.json','department.py'])await unlink(path.join(directory,name)).catch(e=>{if(e.code!=='ENOENT')throw e;});
      await rmdir(directory);
    },
  };
}
const ack=body=>({sessionId:body.sessionId,sequence:body.sequence??0,remainingSeconds:90});

for(const mode of ['owner cancellation','heartbeat denial'])test(`${mode} terminates an active direct child`,{timeout:45000},async()=>{
  const fixture=await childFixture(),controller=new AbortController(),calls=[];
  let deny=false,job;
  try{
    const transport=async(route,body)=>{
      calls.push({route,body:structuredClone(body)});
      if(deny){const error=new Error('Lease lost');error.retryable=false;throw error;}
      return ack(body);
    };
    job=runDepartment({role:'researcher',python:process.execPath,directory:fixture.directory,env:{},transport},1,controller.signal);
    const child=await fixture.started();
    if(mode==='owner cancellation')controller.abort();else deny=true;
    const code=await job;
    assert.equal(code,mode==='owner cancellation'?130:1);
    assert.throws(()=>process.kill(child.pid,0),error=>error.code==='ESRCH');
    assert.equal(calls.filter(c=>c.route==='/workers/sessions').length,1);
    if(mode==='owner cancellation')assert.equal(calls.at(-1).body.state,'stopped');
    else assert.equal(calls.some(c=>c.body.state==='stopped'),false);
  }finally{controller.abort();await job;await fixture.close();}
});
