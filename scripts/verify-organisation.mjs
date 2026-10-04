import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { applyStarter, sha, validatePlan } from './organisation-starter.mjs';
import { prepareDepartment, runDepartment } from './department-runtime.mjs';

// Never load .env or open the persistent paper database. Activation is confined
// to the fresh in-memory fixture; child processes receive one ephemeral role.
const root=fileURLToPath(new URL('../',import.meta.url));
const reportPath=path.join(root,'.local','organisation-verification.json');
const controller=new AbortController(),checks=[],results=[];
let fixture,app,team=[],phase='preflight',report;
const startedAt=new Date().toISOString();
const stop=()=>controller.abort();
process.once('SIGINT',stop);process.once('SIGTERM',stop);
const timeout=setTimeout(stop,330_000);
function check(name){checks.push(name);console.log(JSON.stringify({check:name,status:'passed'}));}
try {
  const bytes=await readFile(path.join(root,'.local','organisation-starter','plan.json'));
  const lock=(await readFile(path.join(root,'integrations','skfolio','dependencies.lock.json'),'utf8')).replace(/\r\n/g,'\n');
  const plan=validatePlan(JSON.parse(bytes),sha(lock)),planHash=sha(bytes);
  const {fixture:makeFixture,key}=await import('../backend/dist/test/helpers.js');
  const {createApp}=await import('../backend/dist/src/app.js');
  fixture=await makeFixture();app=await createApp(fixture.cfg,fixture.db,true);
  await app.listen(0,'127.0.0.1');const base=await app.getUrl();
  const token=role=>fixture.cfg.principals.find(p=>p.role===role).token;
  async function api(role,route,body,id=key()) {
    const response=await fetch(base+'/v1'+route,{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(20000),
      headers:{Authorization:'Bearer '+token(role),'Content-Type':'application/json','Idempotency-Key':id},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    // Do not dump response payloads, role tokens or training observations.
    if(!response.ok)throw new Error(`${route}: HTTP ${response.status}`);
    return response.json();
  }
  phase='starter-import-and-replay';
  const imported=await applyStarter(plan,planHash,api);
  assert.deepEqual(await applyStarter(plan,planHash,api),imported);
  const lifecycle=await api('owner','/lifecycle'),dispatch=await api('owner','/dispatch'),learning=await api('owner','/learning');
  assert.equal(lifecycle.blueprints.length,3);assert.equal(lifecycle.students.length,0);
  assert.equal(lifecycle.policy.rules.enabled,false);assert.equal(dispatch.policy.rules.enabled,false);assert.equal(learning.policy.enabled,false);
  assert.equal(imported.datasetIds.length,9);assert.equal((await api('owner','/bots')).length,1);
  check('starter imports and replays through real HTTP without enabling policies or duplicating records');

  phase='isolated-policy-activation';
  // Use the actual generated limits: three students, 27 assignments/reflections.
  for(const [name,body] of Object.entries(imported.activation))await api('owner',`/${name}/policy`,body);
  // Exercise the optional exam gate in this fixture, without changing starter defaults.
  await api('owner','/skills/policy',{expectedRevision:0,enabled:true,maxPerDay:9,maxLifetime:9});
  const environment={...process.env,API_URL:base,PRINCIPALS_JSON:JSON.stringify(fixture.cfg.principals)};
  const configs=['researcher','evaluator'].map(role=>prepareDepartment(role,environment));
  for(const config of configs){
    assert.equal(config.env.API_TOKEN,token(config.role));assert.equal(config.env.PRINCIPALS_JSON,undefined);
    assert.equal(Object.values(config.env).includes(token('owner')),false);
  }
  check('department children receive only their own ephemeral role credential');

  phase='monitored-team';
  team=configs.map(config=>runDepartment(config,5,controller.signal).then(code=>{results.push({role:config.role,code});return code;}));
  const waitFor=async(predicate,description)=>{
    while(!controller.signal.aborted){
      if(results.length)throw new Error('A department stopped before '+description);
      const value=await predicate();if(value)return value;
      await delay(2500,undefined,{signal:controller.signal}).catch(error=>{if(error.name!=='AbortError')throw error;});
    }
    throw new Error('Verification interrupted or exceeded its deadline: '+description);
  };
  const running=await waitFor(async()=>{const status=await api('owner','/workers');return status.status==='responding'?status:null;},'both supervisors responding');
  const competitor=await runDepartment(configs[0],0,new AbortController().signal);
  assert.equal(competitor,1);
  const after=await api('owner','/workers');
  assert.equal(after.workers.find(w=>w.role==='researcher').sessionId,running.workers.find(w=>w.role==='researcher').sessionId);
  check('concurrent supervisor for an occupied role is refused without replacing the current session');

  const completed=await waitFor(async()=>{
    const state=await api('owner','/lifecycle'),memory=await api('owner','/learning');
    assert.ok(state.students.length<=3);assert.ok(memory.counts.total<=27);
    if(state.students.length===3&&state.students.every(b=>b.state==='college')&&memory.counts.historically_verified>0)
      return {state,memory};
    return null;
  },'three college students and independently verified memory');
  check('real department cycles admit three distinct students, evaluate research and verify shared memory');
  const exams=await api('owner','/skills');
  assert.equal(exams.attempts.length,3);assert.ok(exams.attempts.every(a=>a.outcome==='passed'));
  const versions=await api('owner','/skills/versions');assert.equal(versions.producers.length,1);
  assert.ok(exams.attempts.every(a=>a.producer_hash===versions.producers[0].hash));
  assert.equal((await api('owner','/skills/diagnostics')).cases.length,0);
  assert.equal(new Set(exams.attempts.map(a=>a.bot_id)).size,3);
  check('each managed student passes an independently graded research-basics exam before admission');
  check('actual Python worker fingerprint is bound to every exam without generating false failure diagnoses');
  const trials=await api('owner','/portfolio/trials');
  assert.ok(trials.some(t=>t.state==='evaluated'));
  assert.ok(trials.filter(t=>t.state==='evaluated').every(t=>t.report.promotionAllowed===false));
  const shared=await api('owner','/learning/memory',{});assert.ok(shared.items.length>0);
  assert.equal(new Set(completed.state.students.map(b=>b.method)).size,3);
  const live=await api('owner','/workers');assert.equal(live.status,'responding');
  assert.ok(live.workers.every(w=>w.failedCycles===0&&w.completedCycles>=2));
  check('both supervisors remain fresh across multiple real cycles without failed work');

  phase='shutdown-and-invariants';controller.abort();await Promise.all(team);
  assert.ok(results.every(r=>r.code===130));
  const stopped=await api('owner','/workers');assert.ok(stopped.workers.every(w=>w.status==='stopped'));
  check('team cancellation waits for child exit and reports stopped sessions');
  const treasury=await api('owner','/treasury');assert.equal(treasury.wallet1Paise,'0');assert.equal(treasury.wallet2Paise,'0');
  assert.equal((await api('owner','/treasury/ledger')).length,0);
  assert.equal((await api('owner','/audit/integrity')).valid,true);
  const bots=await api('owner','/bots');assert.ok(bots.every(b=>b.state==='college'||b.state==='school'));
  const budgets=await fixture.db.transaction(tx=>tx.query('SELECT budget_paise FROM bots'));
  assert.ok(budgets.rows.every(b=>String(b.budget_paise)==='0'));
  check('all bots retain zero budgets, no trading graduation, empty wallets/ledger and valid audit chain');
  report={status:'passed',phase:'complete',planHash,checks,students:completed.state.students.length,
    evaluatedTrials:trials.filter(t=>t.state==='evaluated').length,verifiedMemories:completed.memory.counts.historically_verified,passedExams:exams.attempts.length,producerHash:versions.producers[0].hash,
    results,scope:'isolated example research; not model training or live trading'};
}catch(error){report={status:'failed',phase,checks,error:error.message};process.exitCode=1;}
finally {
  clearTimeout(timeout);controller.abort();await Promise.allSettled(team);
  try{await app?.close();}finally{await fixture?.db.close();}
  process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
  await mkdir(path.dirname(reportPath),{recursive:true});
  await writeFile(reportPath,JSON.stringify({...report,startedAt,finishedAt:new Date().toISOString()},null,2)+'\n');
  console.log(JSON.stringify({status:report.status,phase:report.phase,report:reportPath}));
}
