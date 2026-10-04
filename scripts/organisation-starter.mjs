import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const root=fileURLToPath(new URL('../',import.meta.url));
const directory=path.join(root,'.local','organisation-starter');
export const sha=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value!==null&&typeof value==='object'
  ?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}':JSON.stringify(value);
const bar=z.object({timestamp:z.iso.datetime({offset:true}),returns:z.array(z.number().finite().gt(-1).max(1)).min(4).max(20)}).strict();
const schema=z.object({schema:z.literal('organisation-starter-v1'),createdAt:z.iso.datetime({offset:true}),
  provenance:z.object({package:z.literal('skfolio'),version:z.literal('1.4.11'),dependencyLockSha256:z.string().regex(/^[a-f0-9]{64}$/),
    loader:z.literal('load_sp500_dataset'),priorUse:z.literal('Already used by the offline academy; not unseen evaluation data')}).strict(),
  assets:z.array(z.string().regex(/^[A-Z][A-Z0-9._-]{0,19}$/)).min(4).max(20),
  windows:z.array(z.object({training:z.array(bar).length(252),holdout:z.array(bar).length(63)}).strict()).length(9)}).strict();
const lessonText='Use training observations only for fitting; preserve all held-out results and include entry/exit costs and drawdown. This previously used bundled example supports software education only, not profitable trading, causal explanations or new financial permissions.';
export const specialists=[
  {suffix:'equal',name:'Equal-weight baseline student',specialty:'baseline-comparison',method:'equal_weight',contribution:'Maintain the equal-weight reference for diagnostic comparisons'},
  {suffix:'inverse',name:'Inverse-volatility student',specialty:'volatility-allocation',method:'inverse_volatility',contribution:'Study allocation based on past asset volatility'},
  {suffix:'minimum',name:'Minimum-variance student',specialty:'covariance-allocation',method:'minimum_variance',contribution:'Study constrained covariance-based portfolio allocation'},
];

export function validatePlan(value,lockHash,now=Date.now()) {
  const plan=schema.parse(value);
  if(plan.provenance.dependencyLockSha256!==lockHash)throw new Error('Plan dependency lock differs from this checkout');
  if(Date.parse(plan.createdAt)>now+30000||new Set(plan.assets).size!==plan.assets.length)throw new Error('Invalid plan time or duplicate asset');
  let lastEnd=-Infinity;
  for(const window of plan.windows){
    let previous=-Infinity;
    for(const row of [...window.training,...window.holdout]){
      const instant=Date.parse(row.timestamp);
      if(instant<=previous||instant>now||row.returns.length!==plan.assets.length)throw new Error('Invalid plan chronology or asset dimensions');
      previous=instant;
    }
    if(Date.parse(window.holdout[0].timestamp)<=lastEnd)throw new Error('Starter holdout windows overlap');
    lastEnd=Date.parse(window.holdout.at(-1).timestamp);
    if(Buffer.byteLength(JSON.stringify({...window,assets:plan.assets,purpose:'example-testing',evidenceId:'00000000-0000-4000-8000-000000000000'}))>500*1024)
      throw new Error('Window exceeds API request budget');
  }
  return plan;
}

export function roleCredentials(principals) {
  const credentials={};
  for(const role of ['owner','researcher','evaluator']){
    const matches=principals.filter(p=>p.role===role);
    if(matches.length!==1||typeof matches[0].id!=='string'||!matches[0].id||typeof matches[0].token!=='string'||!matches[0].token)
      throw new Error('Exactly one configured principal is required for each starter role');
    credentials[role]=matches[0];
  }
  if(new Set(Object.values(credentials).map(p=>p.id)).size!==3||new Set(Object.values(credentials).map(p=>p.token)).size!==3)
    throw new Error('Starter roles need distinct identities and tokens');
  return credentials;
}

export function apiOrigin(value) {
  const url=new URL(value);
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||
    !(url.protocol==='https:'||(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))))
    throw new Error('Use an HTTPS or loopback HTTP API origin without credentials or a path');
  return url.origin;
}

// Every request is an explicit fixed route/body. The plan cannot supply URLs,
// code, commands, arbitrary lessons, permissions or financial instructions.
export async function applyStarter(plan,planHash,api) {
  const prefix='starter-'+planHash.slice(0,12),sourceId=prefix+'-source',teacherId=prefix+'-teacher';
  const command=(role,route,body)=>api(role,route,body,'starter-'+sha(planHash+'\n'+role+'\n'+route+'\n'+canonical(body)));
  const health=await api('owner','/health');
  if(health.mode!=='paper'||health.liveExecution!==false)throw new Error('Starter requires the paper backend');
  const life=await api('owner','/lifecycle'),dispatch=await api('owner','/dispatch'),learning=await api('owner','/learning');
  const operations=await api('owner','/operations');
  if(operations.control?.halted!==false)throw new Error('Resolve the system halt before preparing a department');
  if(life.policy.rules.enabled||dispatch.policy.rules.enabled||learning.policy.enabled)throw new Error('Starter requires disabled lifecycle, dispatch and learning policies');
  if(life.students.length||life.blueprints.some(b=>!specialists.some(s=>b.id===prefix+'-'+s.suffix)))
    throw new Error('Starter is for an empty managed community or recovery of this same plan');
  const modelHash=sha(canonical(learning.supportedEngine));
  const existingModel=learning.models.find(m=>m.manifest_hash===modelHash);
  if(existingModel?.revoked)throw new Error('Current reflection profile is revoked; do not bypass it');
  await command('owner','/sources',{id:sourceId,name:'Pinned skfolio bundled historical example',url:'https://github.com/skfolio/skfolio',approved:true});
  await command('owner','/bots',{id:teacherId,name:'Starter curriculum record',department:'education',specialty:'starter-curriculum',method:'reviewed-example-v1',
    contribution:'Preserve the fixed software-research curriculum; this identity is not a trained teaching model',budgetPaise:'0'});
  const evidence=await command('researcher','/evidence',{sourceId,kind:'dataset',publishedAt:plan.createdAt,
    content:`Starter plan ${planHash}. Pinned skfolio ${plan.provenance.version}, dependency lock ${plan.provenance.dependencyLockSha256}. Nine chronological historical example windows; ${plan.assets.length} assets. Previously used by the offline academy. Verification is limited to structural checks and the reviewed local bundle, not market accuracy, source licensing, unseen data or trading skill.`});
  await command('evaluator','/evidence/reviews',{evidenceId:evidence.id,status:'verified'});
  const lesson=await command('researcher','/lessons',{botId:teacherId,evidenceId:evidence.id,content:lessonText});
  await command('evaluator','/lessons/reviews',{lessonId:lesson.id});
  const datasets=[];
  for(const window of plan.windows)datasets.push(await command('owner','/portfolio/datasets',{evidenceId:evidence.id,purpose:'example-testing',assets:plan.assets,...window}));
  for(const {suffix,...specialist} of specialists)await command('owner','/lifecycle/blueprints',{id:prefix+'-'+suffix,...specialist,evidenceId:evidence.id,lessonIds:[lesson.id],mentorId:teacherId});
  const modelId=existingModel?.id??prefix+'-memory';
  if(!existingModel)await command('owner','/learning/models',{id:modelId,name:'Starter factual memory',engine:'factual-reflection-v1'});
  // Recheck revisions after registration. Never rewrite a changed owner policy.
  const currentLife=await api('owner','/lifecycle'),currentDispatch=await api('owner','/dispatch'),currentLearning=await api('owner','/learning');
  if(currentLife.policy.revision!==life.policy.revision||currentDispatch.policy.revision!==dispatch.policy.revision||currentLearning.policy.revision!==learning.policy.revision)
    throw new Error('Owner policy changed during preparation; records are retained, inspect before continuing');
  const knowledge=await api('owner','/knowledge');
  if(!knowledge.evidence.some(e=>e.id===evidence.id)||!knowledge.lessons.some(l=>l.id===lesson.id)||
    specialists.some(s=>!currentLife.blueprints.some(b=>b.id===prefix+'-'+s.suffix&&b.state==='approved'))||
    !currentLearning.models.some(m=>m.id===modelId&&m.manifest_hash===modelHash&&!m.revoked))
    throw new Error('Starter support or blueprint approval changed; cached receipts do not restore revoked authority');
  return {planHash,teacherId,evidenceId:evidence.id,lessonId:lesson.id,datasetIds:datasets.map(d=>d.id),
    blueprints:specialists.map(s=>prefix+'-'+s.suffix),
    activation:{
      lifecycle:{expectedRevision:life.policy.revision,rules:{...life.policy.rules,enabled:true,maxActiveBots:3,maxBirthsPerDay:3,maxLifetimeBots:3,cycleSeconds:60}},
      dispatch:{expectedRevision:dispatch.policy.revision,rules:{...dispatch.policy.rules,enabled:true,datasetIds:datasets.map(d=>d.id),maxAssignmentsPerDay:27,maxLifetimeAssignments:27}},
      learning:{expectedRevision:learning.policy.revision,enabled:true,modelId,maxPerDay:27,maxLifetime:27},
    }};
}

async function readPlan() {
  const bytes=await readFile(path.join(directory,'plan.json'));
  if(bytes.length>8*1024*1024)throw new Error('Starter plan exceeds 8 MB');
  const lock=(await readFile(path.join(root,'integrations','skfolio','dependencies.lock.json'),'utf8')).replace(/\r\n/g,'\n');
  return {plan:validatePlan(JSON.parse(bytes.toString('utf8')),sha(lock)),planHash:sha(bytes)};
}

async function preserve(filename,content) {
  try{await writeFile(filename,content,{flag:'wx'});}
  catch(error){if(error.code!=='EEXIST'||await readFile(filename,'utf8')!==content)throw new Error('Existing starter output differs; preserve and reconcile it before continuing');}
}

async function prepare() {
  const here=path.join(root,'integrations','skfolio'),python=path.join(here,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  if(!existsSync(python))throw new Error('Install the pinned academy environment first');
  const env=Object.fromEntries(['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
  Object.assign(env,{PYTHONNOUSERSITE:'1',PYTHONIOENCODING:'utf-8',OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1',MKL_NUM_THREADS:'1'});
  await new Promise((resolve,reject)=>{
    const child=spawn(python,['prepare_organisation.py'],{cwd:here,env,stdio:'inherit',windowsHide:true,shell:false});
    const timer=setTimeout(()=>child.kill(),90000);
    const stop=()=>child.kill();process.once('SIGINT',stop);process.once('SIGTERM',stop);
    child.once('error',reject);
    child.once('close',code=>{clearTimeout(timer);process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);code===0?resolve():reject(new Error('Starter export did not complete'));});
  });
  const {plan,planHash}=await readPlan();
  const review=['# Review the starter department','',`Plan SHA-256: ${planHash}`,'',
    'This plan uses already-seen skfolio bundled historical examples. No model training, live feed, money or provider calls.',
    `${plan.assets.length} assets, nine windows, 252 training and 63 holdout observations per window.`,
    `First holdout: ${plan.windows[0].holdout[0].timestamp}. Last: ${plan.windows.at(-1).holdout.at(-1).timestamp}.`,
    '',...specialists.map(s=>`- ${s.name}: ${s.contribution}.`),'',
    'Apply registers one source, one zero-budget curriculum identity, one evidence record and lesson with distinct author/reviewer API identities, nine datasets, three blueprints and a factual-memory profile.',
    'Those reviewer calls certify this fixed local software-example contract only. They are not an independent scientific or financial assessment.',
    'Apply leaves all policies disabled and starts no worker. It writes separate proposed activation files: three students, 27 total assignments and 27 factual reflections; no Hermes inference.',
    'The apply parent holds owner/researcher/evaluator credentials for this bounded setup. They are never supplied to the offline exporter or a model.',
    '',`After reviewing plan.json and this file: npm run organisation:apply -- --approve ${planHash}`,'',
    'Preserve this directory. Reruns of the same plan use the same backend idempotency receipts. A different plan does not silently replace an existing community.',''].join('\n');
  await preserve(path.join(directory,'REVIEW.md'),review);
  console.log(JSON.stringify({review:path.join(directory,'REVIEW.md'),planHash,backendChanged:false}));
}

async function main(args) {
  if(args.length===1&&args[0]==='prepare')return prepare();
  if(args.length!==3||args[0]!=='apply'||args[1]!=='--approve'||!/^[a-f0-9]{64}$/.test(args[2]))throw new Error('Use prepare, or apply --approve <reviewed SHA-256>');
  const {plan,planHash}=await readPlan();
  if(args[2]!==planHash)throw new Error('Approval does not match the current plan bytes');
  const credentials=roleCredentials(JSON.parse(process.env.PRINCIPALS_JSON??'[]'));
  const base=apiOrigin(process.env.API_URL??'http://127.0.0.1:3000');
  await mkdir(directory,{recursive:true});
  const binding=JSON.stringify({planHash,base,principals:Object.fromEntries(Object.entries(credentials).map(([role,p])=>[role,p.id]))},null,2)+'\n';
  await preserve(path.join(directory,'binding.json'),binding);
  const api=async(role,route,body,key)=>{
    const response=await fetch(base+'/v1'+route,{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(20000),
      headers:{Authorization:'Bearer '+credentials[role].token,'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    if(!response.ok)throw new Error(`${route}: HTTP ${response.status}; preserve the plan and rerun with the same approval hash after resolving the cause`);
    return response.json();
  };
  const result=await applyStarter(plan,planHash,api);
  await preserve(path.join(directory,'receipt.json'),JSON.stringify({...result,base},null,2)+'\n');
  for(const [name,body] of Object.entries(result.activation))await preserve(path.join(directory,name+'-enable.json'),JSON.stringify(body,null,2)+'\n');
  console.log(JSON.stringify({status:'registered-policies-still-disabled',receipt:path.join(directory,'receipt.json'),
    next:'Review the three *-enable.json files before submitting them with lifecycle:admin. No worker was started.'}));
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).catch(error=>{
  console.error(error instanceof z.ZodError?'Invalid starter plan structure':error.message);process.exitCode=1;
});
