import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdir,writeFile } from 'node:fs/promises';
import { fixture,key,owner,researcher,evaluator } from '../backend/dist/test/helpers.js';
import { createApp } from '../backend/dist/src/app.js';
import { ResearchDevelopment } from '../backend/dist/src/development.js';

const startedAt=new Date().toISOString();let f,app,report;
try{
  f=await fixture();
  for(const id of ['mentor','student'])await f.org.bot(owner,key(),{id,name:id,department:'research',specialty:id,method:'reasoning',contribution:'Distinct fixture role',budgetPaise:'0'});
  await f.org.sources(owner,key(),{id:'publisher',name:'Synthetic publisher',url:'https://example.org',approved:true});
  const evidence=await f.org.observations().ingest(researcher,key(),{sourceId:'publisher',url:'https://example.org/story',title:'Cost principle',kind:'article',content:'Fees and slippage reduce net returns.',publishedAt:'2025-01-01T00:00:00Z'});
  await f.org.reviewEvidence(evaluator,key(),{evidenceId:evidence.id,status:'verified'});
  await new ResearchDevelopment(f.db).configure(owner,key(),{expectedRevision:0,enabled:true,model:{name:'Qwen/Qwen3.5-9B',baseUrl:'http://127.0.0.1:8000/v1'},maxPerDay:3,maxLifetime:3});
  app=await createApp(f.cfg,f.db,true);await app.listen(0,'127.0.0.1');const base=await app.getUrl();
  const token=role=>f.cfg.principals.find(p=>p.role===role).token;
  const env=Object.fromEntries(['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
  Object.assign(env,{API_URL:base,API_TOKEN:token('researcher'),PYTHONIOENCODING:'utf-8',PYTHONNOUSERSITE:'1'});
  async function run(body,role='researcher'){return new Promise((done,reject)=>{
    const child=spawn(resolve('integrations/skfolio/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),
      ['knowledge_fixture.py',JSON.stringify(body)],{cwd:resolve('integrations/hermes'),env:{...env,API_TOKEN:token(role)},windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
    let output='',error='';const timer=setTimeout(()=>child.kill(),60000);
    child.stdout.on('data',b=>{output+=b;if(output.length>65536)child.kill();});
    child.stderr.on('data',b=>{error+=b;if(error.length>16384)child.kill();});
    child.once('error',e=>{clearTimeout(timer);reject(e);});
    child.once('close',code=>{clearTimeout(timer);if(code!==0)return reject(new Error('Knowledge fixture failed: '+error.slice(0,1000)));try{done(JSON.parse(output));}catch(e){reject(e);}});
  });}
  const registered=await fetch(base+'/v1/learning/workflows',{method:'POST',headers:{Authorization:'Bearer '+token('owner'),'Content-Type':'application/json','Idempotency-Key':key()},
    body:JSON.stringify({mentorId:'mentor',recipientId:'student',evidenceId:evidence.id,researcherId:researcher.id,evaluatorId:evaluator.id,task:'Design a new cost-aware strategy comparison'})});
  assert.ok(registered.ok);const {workflowId}=await registered.json();
  const progress=r=>r.result.progress??r.result;
  const sourceLearning=await run({workflowId});assert.equal(progress(sourceLearning).state,'awaiting-source-review');
  const sourceReview=await fetch(base+'/v1/learning/sources/reviews',{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),
    headers:{Authorization:'Bearer '+token('evaluator'),'Content-Type':'application/json','Idempotency-Key':key()},
    body:JSON.stringify({requestId:progress(sourceLearning).links.source,decision:'accepted',reason:'Fixture lesson is grounded in the exact source excerpt; no profitability claim'})});
  assert.ok(sourceReview.ok);assert.equal(sourceLearning.modelStandInCalls,1);
  const result=await run({workflowId});assert.equal(progress(result).state,'awaiting-transfer-review');
  async function post(role,path,body){
    const r=await fetch(base+'/v1/learning/knowledge/'+path,{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),
      headers:{Authorization:'Bearer '+token(role),'Content-Type':'application/json','Idempotency-Key':key()},body:JSON.stringify(body)});
    assert.ok(r.ok,'Knowledge HTTP '+r.status);return r.json();
  }
  await post('evaluator','reviews',{requestId:progress(result).links.transfer,decision:'accepted',reason:'Fixture plan cites the mentor and proposes a check; execution not demonstrated'});
  const issued=await run({workflowId},'evaluator');assert.equal(progress(issued).state,'assessment-answer');assert.equal(issued.modelStandInCalls,0);
  const assessment=await run({workflowId});assert.equal(progress(assessment).state,'assessment-grade');
  assert.equal(assessment.modelStandInCalls,1);
  const completed=await run({workflowId},'evaluator');assert.equal(progress(completed).state,'completed');const grade=progress(completed).assessment;
  assert.equal(grade.outcome,'passed');assert.equal(grade.passedChecks,16);assert.equal(grade.causalImprovementEstablished,false);
  const graph=await post('owner','graph',{botId:'student'});
  assert.ok(graph.edges.some(e=>e.type==='reviewed-plan-for'));assert.ok(graph.edges.some(e=>e.from==='bot:mentor'));
  assert.ok(graph.edges.some(e=>e.type==='tested-by'));
  assert.ok(graph.edges.some(e=>e.type==='extracted-through'));assert.ok(graph.edges.some(e=>e.type==='observed-as'));
  assert.equal(result.modelStandInCalls,1);assert.equal(result.realModelInference,false);
  assert.equal((await f.treasury.snapshot(owner)).wallet1Paise,'0');assert.equal((await f.ops.verifyAudit(owner)).valid,true);
  report={status:'passed',startedAt,finishedAt:new Date().toISOString(),...result,workflowId,workflowCompleted:true,sourceLearning,assessment,grade,nodes:graph.nodes.length,edges:graph.edges.length,
    demonstratedLearning:false,scope:'Two-bot knowledge-transfer protocol with deterministic model stand-in; real inference and learning benefit remain unverified'};
}catch(error){report={status:'failed',startedAt,message:error.message};process.exitCode=1;}
finally{if(app)await app.close();if(f)await f.db.close();}
await mkdir('.local',{recursive:true});await writeFile('.local/knowledge-verification.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
