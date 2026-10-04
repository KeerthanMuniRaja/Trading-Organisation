import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const [command,filename,...extra]=process.argv.slice(2);
const readRoutes={status:'/lifecycle',community:'/lifecycle/community',archives:'/lifecycle/archives',knowledge:'/knowledge',dispatch:'/dispatch',report:'/organisation/report',learning:'/learning',development:'/development',experiments:'/development/experiments',workers:'/workers'};
const writeRoutes={policy:'/lifecycle/policy',blueprint:'/lifecycle/blueprints',withdraw:'/lifecycle/withdrawals','dispatch-policy':'/dispatch/policy','cancel-assignment':'/dispatch/cancellations',model:'/learning/models','revoke-model':'/learning/model-revocations','learning-policy':'/learning/policy',memory:'/learning/memory','development-policy':'/development/policy','development-review':'/development/reviews',experiment:'/development/experiments','cancel-experiment':'/development/experiments/cancellations'};
readRoutes.skills='/skills';
writeRoutes['skills-policy']='/skills/policy';
readRoutes['skill-recoveries']='/skills/recoveries';
writeRoutes['skill-recovery']='/skills/recoveries';
writeRoutes['revoke-skill-recovery']='/skills/recoveries/revocations';
readRoutes['skill-diagnostics']='/skills/diagnostics';
readRoutes['skill-versions']='/skills/versions';
writeRoutes['compare-skill-versions']='/skills/versions/comparisons';
readRoutes['skill-experiments']='/skills/experiments';
writeRoutes['knowledge-graph']='/learning/knowledge/graph';
readRoutes['execution-reports']='/skills/experiments/execution-reports';
readRoutes['research-approvals']='/skills/experiments/research-approvals';
writeRoutes['approve-research']='/skills/experiments/research-approvals';
writeRoutes['revoke-research']='/skills/experiments/research-approvals/revocations';
writeRoutes['skill-experiment']='/skills/experiments';
writeRoutes['cancel-skill-experiment']='/skills/experiments/cancellations';
if(extra.length||(!readRoutes[command]&&!writeRoutes[command])||(readRoutes[command]&&filename)||(writeRoutes[command]&&!filename))throw new Error('Read: '+Object.keys(readRoutes).join('|')+'. JSON file commands: '+Object.keys(writeRoutes).join('|')+'.');
const credential=JSON.parse(process.env.PRINCIPALS_JSON??'[]').find(p=>p.role==='owner');
if(!credential)throw new Error('Owner credential is required for lifecycle administration');
const base=new URL(process.env.API_URL??'http://127.0.0.1:3000');
if(base.username||base.password||base.search||base.hash||base.pathname!=='/'||
  (base.protocol!=='https:'&&!(base.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(base.hostname))))throw new Error('Use HTTPS or a loopback HTTP API origin without credentials, path, query or fragment');
let body;
if(filename){
  const content=await readFile(filename,'utf8');
  if(Buffer.byteLength(content)>32*1024)throw new Error('Lifecycle request exceeds 32 KB');
  body=JSON.stringify(JSON.parse(content));
}
const key=body?'lifecycle-admin-'+createHash('sha256').update(command+'\n'+body).digest('hex'):undefined;
const response=await fetch(new URL('/v1'+(readRoutes[command]??writeRoutes[command]),base),{method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(20_000),
  headers:{Authorization:'Bearer '+credential.token,'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},...(body?{body}:{})});
const value=await response.json();
if(!response.ok){console.error(JSON.stringify({status:response.status,error:value},null,2));process.exitCode=1;}
else console.log(JSON.stringify(value,null,2));
