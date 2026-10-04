import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
process.chdir(root);
if(process.argv.length>3||(process.argv[2]&&process.argv[2]!=='--artifacts'))throw new Error('Optional argument: --artifacts');
const artifactMode=process.argv[2]==='--artifacts';
const artifactDirectory=resolve(root,'.local/paired-artifact-fixtures',randomUUID());
const directory=resolve(root,'integrations/skfolio');
const python=resolve(directory,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const env=Object.fromEntries(['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
Object.assign(env,{PYTHONNOUSERSITE:'1',PYTHONIOENCODING:'utf-8'});
function run(args,extra={}){
  return new Promise((done,reject)=>{
    const child=spawn(python,[artifactMode?'paired_artifact_fixture.py':'paired_fixture.py',...args],{cwd:directory,env:{...env,...extra},shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',oversized=false,timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;child.kill();},artifactMode?60_000:30_000);
    child.stdout.on('data',chunk=>{stdout+=chunk;if(Buffer.byteLength(stdout)>64*1024){oversized=true;child.kill();}});
    child.stderr.on('data',chunk=>{stderr+=chunk;if(Buffer.byteLength(stderr)>16*1024){oversized=true;child.kill();}});
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('close',code=>{
      clearTimeout(timer);
      if(timedOut||oversized||code!==0)return reject(new Error(timedOut?'Paired fixture timed out':oversized?'Fixture output too large':stderr.slice(0,2000)||`Fixture exited ${code}`));
      try{done(JSON.parse(stdout));}catch{reject(new Error('Invalid fixture JSON'));}
    });
  });
}
const startedAt=new Date().toISOString();
let f,app,report;
try{
  const {createApp}=await import('../backend/dist/src/app.js');
  const {fixture,key}=await import('../backend/dist/test/helpers.js');
  const manifests=await run(artifactMode?['--prepare',artifactDirectory]:['--manifests']);
  f=await fixture();app=await createApp(f.cfg,f.db,true);await app.listen(0,'127.0.0.1');
  const base=await app.getUrl(),credential=role=>f.cfg.principals.find(p=>p.role===role).token;
  async function api(role,path,body){
    const response=await fetch(base+'/v1'+path,{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(20_000),
      headers:{Authorization:'Bearer '+credential(role),'Content-Type':'application/json','Idempotency-Key':key()},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    const value=await response.json();assert.ok(response.ok,`${path}: HTTP ${response.status}`);return value;
  }
  await api('owner','/skills/policy',{expectedRevision:0,enabled:true,maxPerDay:12,maxLifetime:100});
  const p=await api('owner','/skills/experiments',{...manifests,researcherId:'researcher',caseCount:8,
    criteria:{minCandidatePassBps:10000,maxRegressions:0,minImprovements:8},purpose:'Isolated fixture with deliberately injected cost errors; not a real model upgrade'});
  const execution=await run(artifactMode?[p.experimentId,artifactDirectory]:[p.experimentId],{API_URL:base,API_TOKEN:credential('researcher')});
  assert.equal(execution.status,'submitted');
  if(artifactMode){assert.equal(execution.executions,2);assert.equal(execution.unconfirmedSubmissions,1);
    assert.deepEqual(execution.sourceHashes,[manifests.baseline.sourceSha256,manifests.candidate.sourceSha256]);}
  const review=await api('evaluator','/skills/experiments/reviews',{experimentId:p.experimentId});
  assert.equal(review.outcome,'meets-criteria');assert.equal(review.promotionAllowed,false);
  assert.deepEqual(review.totals,{baselinePassed:24,candidatePassed:32,improvements:8,regressions:0,totalChecks:32});
  assert.equal((await api('owner','/skills/experiments')).experiments.length,1);
  if(artifactMode){
    assert.deepEqual(execution.executionReporting,{pending:0,reported:true});
    const monitoring=await api('owner','/skills/experiments/execution-reports');
    assert.equal(monitoring.verifiedExecution,false);assert.equal(monitoring.liveness,'not-established');
    const stream=monitoring.streams.find(s=>s.experiment_id===p.experimentId);
    assert.equal(stream.mode,'trusted-local-process-only');assert.equal(stream.backend_submission_received,true);
    assert.equal(stream.backend_review_outcome,'meets-criteria');
    assert.deepEqual(stream.observations.map(o=>o.event.state),['started','succeeded','started','succeeded','unconfirmed','confirmed']);
  }
  const counts=await f.db.transaction(async tx=>{
    const result={};for(const table of ['bots','skill_attempts','lessons','journals'])
      result[table]=Number((await tx.query('SELECT count(*) AS n FROM '+table)).rows[0].n);
    return result;
  });
  assert.ok(Object.values(counts).every(n=>n===0));
  assert.equal((await api('owner','/audit/integrity')).valid,true);
  report={status:'passed',startedAt,finishedAt:new Date().toISOString(),experimentId:p.experimentId,planHash:p.planHash,
    totals:review.totals,promotionAllowed:false,counts,
    ...(artifactMode?{execution,artifactDirectory}:{}),
    scope:artifactMode?'Hash-checked trusted local source snapshots and durable actual HTTP replay; no OS sandbox or remote attestation':
      'Actual Python-to-HTTP paired protocol with deliberately injected fixture errors; no model learning or verified artifact execution'};
}catch(error){report={status:'failed',startedAt,finishedAt:new Date().toISOString(),message:error.message};process.exitCode=1;}
finally{if(app)await app.close();if(f)await f.db.close();}
await mkdir(resolve(root,'.local'),{recursive:true});
await writeFile(resolve(root,artifactMode?'.local/paired-artifacts-verification.json':'.local/paired-skills-verification.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
