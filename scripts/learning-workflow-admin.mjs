import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const routes={create:'',progress:'/progress',cancel:'/cancellations'};
try{
  const [action,file]=process.argv.slice(2);
  if(process.argv.length!==4||!Object.hasOwn(routes,action))throw new Error('Use create, progress or cancel followed by a JSON file');
  const raw=await readFile(file);if(raw.length>8192)throw new Error('Workflow input exceeds 8 KiB');
  const body=JSON.parse(raw),principals=JSON.parse(process.env.PRINCIPALS_JSON??'[]').filter(p=>p.role==='owner');
  if(principals.length!==1)throw new Error('Exactly one owner credential required');
  const base=new URL(process.env.API_URL??'http://127.0.0.1:3000');
  if(base.username||base.password||base.search||base.hash||base.pathname!=='/'||
    !(base.protocol==='https:'||(base.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(base.hostname))))throw new Error('Invalid backend origin');
  const response=await fetch(new URL('/v1/learning/workflows'+routes[action],base),{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),
    headers:{Authorization:'Bearer '+principals[0].token,'Content-Type':'application/json','Idempotency-Key':'workflow-admin-'+createHash('sha256').update(action+JSON.stringify(body)).digest('hex')},body:JSON.stringify(body)});
  if(!response.ok)throw new Error('Workflow command HTTP '+response.status);
  console.log(JSON.stringify(await response.json()));
}catch(error){console.error(error.message);process.exitCode=1;}
