import { readFile, writeFile } from 'node:fs/promises';
import { sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const base = process.env.API_URL ?? 'http://127.0.0.1:3000';
if(!['deterministic','hermes'].includes(process.env.RESEARCH_ENGINE??'deterministic')) throw new Error('Unknown research engine');
const origin = new URL(base);
if (!['127.0.0.1','localhost','[::1]'].includes(origin.hostname)) throw new Error('Demo is restricted to a local paper backend');
const health = await (await fetch(base+'/v1/health')).json();
if (health.mode !== 'paper' || health.liveExecution !== false) throw new Error('Refusing a non-paper backend');
const principals = JSON.parse(process.env.PRINCIPALS_JSON ?? '[]');
const credentials = Object.fromEntries(principals.map(p=>[p.role,p.token]));
const privateKey = await readFile('.local/owner-signing-key.pem','utf8');
async function api(role,path,body,key) {
  const response=await fetch(base+'/v1'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+credentials[role],'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const result=await response.json();
  if(!response.ok)throw new Error(`${path}: ${response.status} ${JSON.stringify(result)}`);
  return result;
}
async function ownerAction(request,key) {
  const challenge=await api('owner','/owner/challenges',request);
  const signature=sign(null,Buffer.from(challenge.message),privateKey).toString('base64url');
  return api('owner','/owner/transactions',{request,proof:{challengeId:challenge.challengeId,signature}},key);
}
function runWorker(role) {
  const python=process.env.PYTHON_BIN ?? (process.platform==='win32'?'python':'python3');
  // Research/evaluation child processes receive only their own scoped token.
  const env=Object.fromEntries(['PATH','Path','SystemRoot','SYSTEMROOT','TEMP','TMP'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
  Object.assign(env,{API_URL:base,API_TOKEN:credentials[role],PYTHONIOENCODING:'utf-8'});
  const hermes=role==='researcher'&&process.env.RESEARCH_ENGINE==='hermes';
  if(hermes)for(const name of ['HERMES_ENABLED','HERMES_SOURCE_PATH','HERMES_PYTHON','HERMES_MODEL','HERMES_MODEL_BASE_URL','HERMES_MODEL_API_KEY'])if(process.env[name])env[name]=process.env[name];
  const script=hermes?'integrations/hermes/worker.py':'services/research/worker.py';
  const result=spawnSync(python,[script,'--role',role,'--once'],{env,encoding:'utf8',windowsHide:true,timeout:115000});
  if(result.error)throw result.error;
  if(result.status!==0)throw new Error(result.stderr || `Worker exited ${result.status}`);
  if(result.stdout)process.stdout.write(result.stdout);
}
const bars=(n,start,offset)=>Array.from({length:n},(_,i)=>({timestamp:new Date(Date.UTC(2025,0,1+i+offset)).toISOString(),closePaise:String(start+i*100)}));
await api('owner','/sources',{id:'demo-source',name:'Synthetic education fixture',url:'https://example.org/synthetic-fixture',approved:true},'demo-v1-source');
const evidence=await api('researcher','/evidence',{sourceId:'demo-source',kind:'dataset',content:'Synthetic increasing prices for a software demonstration. This is not market evidence or a profitability claim.',publishedAt:'2025-01-01T00:00:00Z'},'demo-v1-evidence');
await api('evaluator','/evidence/reviews',{evidenceId:evidence.id,status:'verified'},'demo-v1-evidence-review');
await api('owner','/bots',{id:'trend-bot',name:'Trend research student',department:'research',specialty:'daily-trend',method:'momentum-v1',contribution:'Prior-close momentum with chronological evaluation and explicit costs',budgetPaise:'100000'},'demo-v1-bot');
const lesson=await api('researcher','/lessons',{botId:'trend-bot',content:'Signals must use prior observations; retain failed trials and account for costs.',evidenceId:evidence.id},'demo-v1-lesson');
await api('evaluator','/lessons/reviews',{lessonId:lesson.id},'demo-v1-lesson-review');
await api('owner','/bots/school-completions',{botId:'trend-bot',lessonIds:[lesson.id]},'demo-v1-school');
const dataset=await api('owner','/datasets',{evidenceId:evidence.id,training:bars(60,10000,0),holdout:bars(60,16000,60)},'demo-v1-dataset');
await api('researcher','/experiments',{botId:'trend-bot',datasetId:dataset.id,hypothesis:'Can prior-close momentum beat cash after costs on this synthetic fixture?'},'demo-v1-experiment');
runWorker('researcher');runWorker('evaluator');
const bots=await api('owner','/bots');
if(bots.find(b=>b.id==='trend-bot')?.state!=='paper')throw new Error('Candidate did not qualify for paper operation');
await ownerAction({action:'deposit',payload:{amountPaise:'1000000',bankReference:'demo-v1-contribution'}},'demo-v1-deposit');
const quote=async price=>{const instant=new Date().toISOString();return api('market','/market/quotes',{symbol:'DEMO',bidPaise:price,askPaise:price,observedAt:instant,sourceId:'demo-source'},'quote-'+Date.now());};
await quote('10000');
const buy=await api('trader','/paper/orders',{botId:'trend-bot',symbol:'DEMO',side:'buy',quantity:5,evidenceId:evidence.id},'demo-v1-buy');
await api('trader','/paper/fills',{orderId:buy.id},'demo-v1-buy-fill');
await quote('11000');
const sell=await api('trader','/paper/orders',{botId:'trend-bot',symbol:'DEMO',side:'sell',quantity:5,evidenceId:evidence.id},'demo-v1-sell');
await api('trader','/paper/fills',{orderId:sell.id},'demo-v1-sell-fill');
const allocation=await api('treasury','/treasury/allocations',{},'demo-v1-allocation');
await api('treasury','/treasury/confirmations',{allocationId:allocation.allocationId},'demo-v1-confirmation');
const report={mode:'paper',data:'synthetic',bots:await api('owner','/bots'),treasury:await api('owner','/treasury'),audit:await api('owner','/audit/integrity')};
await writeFile('.local/demo-report.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
