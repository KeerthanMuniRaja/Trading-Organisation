import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function validateBatch(value){
  if(!Array.isArray(value)||value.length<1||value.length>25)throw new Error('Provide an array of 1–25 observations');
  const fields=['sourceId','url','title','kind','content','publishedAt'];
  return value.map(row=>{
    if(!row||typeof row!=='object'||Object.keys(row).length!==fields.length||fields.some(k=>typeof row[k]!=='string'))
      throw new Error('Each observation requires sourceId, url, title, kind, content and publishedAt only');
    if(!/^[a-zA-Z0-9_-]{1,80}$/.test(row.sourceId)||!['news','article','filing'].includes(row.kind)||
      !row.content.trim()||row.content.length>4000||!row.title.trim()||row.title.length>300||row.url.length>2048||
      !Number.isFinite(Date.parse(row.publishedAt)))throw new Error('Invalid observation fields');
    const u=new URL(row.url);if(u.protocol!=='https:'||u.username||u.password||u.hash)throw new Error('Observation URL must be HTTPS without credentials or fragment');
    return Object.fromEntries(fields.map(k=>[k,row[k]]));
  });
}
export async function importBatch(value,env=process.env,transport=fetch){
  const rows=validateBatch(value),base=new URL(env.API_URL??'http://127.0.0.1:3000');
  if(base.username||base.password||base.search||base.hash||base.pathname!=='/'||
    !(base.protocol==='https:'||(base.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(base.hostname))))throw new Error('Invalid backend API origin');
  const principals=JSON.parse(env.PRINCIPALS_JSON??'[]').filter(p=>p.role==='researcher');
  if(principals.length!==1||typeof principals[0].token!=='string'||!principals[0].token)throw new Error('Configure exactly one researcher credential');
  const results=[];
  for(const [index,row] of rows.entries()){
    const body=JSON.stringify(row),key='observation-'+createHash('sha256').update(body).digest('hex');
    try{
      const response=await transport(new URL('/v1/sources/observations',base),{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),
        headers:{Authorization:'Bearer '+principals[0].token,'Content-Type':'application/json','Idempotency-Key':key},body});
      if(!response.ok)throw new Error('HTTP '+response.status);
      const result=await response.json();
      if(typeof result.id!=='string')throw new Error('Invalid acknowledgement');
      results.push({id:result.id,status:result.status});
    }catch{
      throw new Error(`Observation ${index+1} was not acknowledged; ${results.length} prior acknowledgements. Rerun the unchanged file to recover safely.`);
    }
  }
  return {submitted:results.length,results,reviewRequired:true};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    if(process.argv.length!==3)throw new Error('Usage: npm run sources:import -- observations.json');
    const handle=await open(process.argv[2],'r');let data;
    try{const buffer=Buffer.alloc(262145),{bytesRead}=await handle.read(buffer,0,buffer.length,0);
      if(bytesRead>262144)throw new Error('Observation file exceeds 256 KiB');data=buffer.subarray(0,bytesRead).toString('utf8');
    }finally{await handle.close();}
    console.log(JSON.stringify(await importBatch(JSON.parse(data))));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
