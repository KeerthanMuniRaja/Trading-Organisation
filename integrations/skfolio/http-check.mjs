import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Fresh in-memory backend, ephemeral credentials, and bundled example data only.
// No .env, persistent paper database, signing key, model API or exchange access.
const directory=dirname(fileURLToPath(import.meta.url));
process.chdir(resolve(directory,'../..'));
const python=join(directory,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const state=join(directory,'.state');
await mkdir(state,{recursive:true});
let fixture,app,phase='preflight',report;
const env=Object.fromEntries(['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
Object.assign(env,{PYTHONNOUSERSITE:'1',PYTHONIOENCODING:'utf-8',OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1',MKL_NUM_THREADS:'1'});
function runPython(args,extra={}) {
  return new Promise((resolveRun,reject)=>{
    const child=spawn(python,args,{cwd:directory,env:{...env,...extra},windowsHide:true,stdio:['ignore','pipe','pipe'],shell:false});
    let stdout='',stderr='',oversized=false;
    const timeout=setTimeout(()=>{child.kill();reject(new Error('Python integration stage exceeded 90 seconds'));},90_000);
    child.stdout.on('data',chunk=>{stdout+=chunk;if(Buffer.byteLength(stdout)>512*1024){oversized=true;child.kill();}});
    child.stderr.on('data',chunk=>{stderr+=chunk;if(Buffer.byteLength(stderr)>32*1024){oversized=true;child.kill();}});
    child.on('error',error=>{clearTimeout(timeout);reject(error);});
    child.on('close',code=>{
      clearTimeout(timeout);
      if(oversized||code!==0)return reject(new Error(oversized?'Worker exceeded output limit':stderr.slice(0,2000)||`Worker exited ${code}`));
      try{resolveRun(JSON.parse(stdout));}catch{reject(new Error('Worker returned invalid JSON'));}
    });
  });
}
try {
  if(!existsSync(python))throw new Error('Academy Python environment is missing; see docs/portfolio-backend.md');
  const {createApp}=await import('../../backend/dist/src/app.js');
  const helpers=await import('../../backend/dist/test/helpers.js');
  fixture=await helpers.fixture();
  app=await createApp(fixture.cfg,fixture.db,true);
  await app.listen(0,'127.0.0.1');const base=await app.getUrl();
  const credential=role=>fixture.cfg.principals.find(p=>p.role===role).token;
  async function request(role,path,body,key=helpers.key()) {
    return fetch(base+'/v1'+path,{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(15_000),
      headers:{Authorization:'Bearer '+credential(role),'Content-Type':'application/json','Idempotency-Key':key},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
  }
  async function api(role,path,body,key){
    const response=await request(role,path,body,key);
    const value=await response.json();
    if(!response.ok)throw new Error(`${path}: HTTP ${response.status}: ${JSON.stringify(value)}`);
    return value;
  }
  phase='bundled-example-data';
  const {reference,...data}=await runPython(['http_fixture.py']);
  await api('owner','/sources',{id:'portfolio-fixture',name:'skfolio bundled example; testing only',url:'https://github.com/skfolio/skfolio',approved:true});
  const evidence=await api('researcher','/evidence',{sourceId:'portfolio-fixture',kind:'dataset',content:'Pinned skfolio 1.4.11 bundled selected-20 historical example, restricted to software testing. Already used in local examples; not a pristine research holdout or authorised production feed.',publishedAt:'2022-12-28T00:00:00Z'});
  await api('evaluator','/evidence/reviews',{evidenceId:evidence.id,status:'verified'});
  await api('owner','/bots',{id:'portfolio-student',name:'Portfolio integration student',department:'research',specialty:'allocation',method:'portfolio-example-v1',contribution:'Software test of independent cost-aware portfolio evaluation',budgetPaise:'0'});
  const lesson=await api('researcher','/lessons',{botId:'portfolio-student',evidenceId:evidence.id,content:'Fit on past observations; keep example data out of trading qualification.'});
  await api('evaluator','/lessons/reviews',{lessonId:lesson.id});
  await api('owner','/bots/school-completions',{botId:'portfolio-student',lessonIds:[lesson.id]});
  const dataset=await api('owner','/portfolio/datasets',{...data,evidenceId:evidence.id});
  phase='python-to-backend-training-and-evaluation';
  const trials=[];
  for(const method of ['equal_weight','inverse_volatility','minimum_variance']){
    const training=await api('researcher','/portfolio/training',{datasetId:dataset.id});
    assert.equal('holdout' in training,false);
    const args=['bridge.py','researcher','--bot-id','portfolio-student','--dataset-id',dataset.id,'--method',method];
    const researcherEnv={API_URL:base,API_TOKEN:credential('researcher')};
    const trial=await runPython(args,researcherEnv);
    assert.deepEqual(await runPython(args,researcherEnv),trial);
    assert.equal((await request('researcher','/portfolio/reviews',{trialId:trial.id})).status,403);
    const reviewArgs=['bridge.py','evaluator','--trial-id',trial.id],evaluatorEnv={API_URL:base,API_TOKEN:credential('evaluator')};
    const reviewed=await runPython(reviewArgs,evaluatorEnv);
    assert.deepEqual(await runPython(reviewArgs,evaluatorEnv),reviewed);
    assert.equal(reviewed.report.promotionAllowed,false);
    for(const metric of ['netReturnBps','maxDrawdownBps']){
      assert.ok(Math.abs(reviewed.report[metric]-reference[method][metric])<0.01,`${method} ${metric} differs from Python reference`);
    }
    trials.push({method,id:trial.id,report:reviewed.report});
  }
  phase='permissions-notifications-and-ledger';
  assert.equal((await request('researcher','/portfolio/trials')).status,403);
  assert.equal((await request('researcher','/treasury')).status,403);
  const reports=await api('owner','/portfolio/trials');assert.equal(reports.length,3);
  const operations=await api('owner','/operations');
  assert.equal(operations.notifications.filter(n=>n.summary.startsWith('portfolio.trial.evaluated')).length,3);
  assert.equal((await api('owner','/bots'))[0].state,'college');
  const treasury=await api('owner','/treasury');assert.equal(treasury.wallet1Paise,'0');assert.equal(treasury.wallet2Paise,'0');
  assert.equal((await api('owner','/treasury/ledger')).length,0);
  assert.equal((await api('owner','/audit/integrity')).valid,true);
  report={status:'passed',phase:'complete',checks:['actual skfolio fitting via scoped Python worker','backend holdout scoring agrees with Python reference','exact replay without duplicate trials or notifications','researcher cannot evaluate or read reports/wallet','example data leaves bot in college','empty financial ledger','valid audit chain'],trials,
    note:'Example-data software integration only. No models or money used.'};
}catch(error){
  report={status:'failed',phase,error:String(error.message).slice(0,2000)};process.exitCode=1;
}finally{
  try{await app?.close();}finally{await fixture?.db.close();}
  await writeFile(join(state,'last-http-check.json'),JSON.stringify({...report,checkedAt:new Date().toISOString()},null,2));
  console.log(JSON.stringify(report,null,2));
}
