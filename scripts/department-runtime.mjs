import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DepartmentSession, supervisorTransport } from './department-session.mjs';

export function duration(args,{required=false}={}) {
  if(!args.length&&!required)return 0;
  if(args.length!==2||args[0]!=='--minutes'||!/^\d{1,3}$/.test(args[1])||Number(args[1])>360||(required&&Number(args[1])<1))
    throw new Error(required?'Use --minutes 1..360':'Use --minutes 0..360, or omit for one cycle');
  return Number(args[1]);
}
export function prepareDepartment(role,environment=process.env) {
  if(!['researcher','evaluator'].includes(role))throw new Error('Choose researcher or evaluator');
  const root=fileURLToPath(new URL('../',import.meta.url)),directory=path.join(root,'integrations','skfolio');
  const python=path.join(directory,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  if(!existsSync(python))throw new Error('Install the pinned academy environment; see docs/portfolio-academy.md');
  const principals=JSON.parse(environment.PRINCIPALS_JSON??'[]').filter(p=>p.role===role);
  if(principals.length!==1)throw new Error(`Configure exactly one scoped ${role} principal`);
  const principal=principals[0];
  const env=Object.fromEntries(['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP'].filter(k=>environment[k]).map(k=>[k,environment[k]]));
  Object.assign(env,{API_URL:environment.API_URL??'http://127.0.0.1:3000',API_TOKEN:principal.token,
    PYTHONNOUSERSITE:'1',PYTHONIOENCODING:'utf-8',OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1',MKL_NUM_THREADS:'1'});
  return {role,python,directory,env,transport:supervisorTransport(env)};
}
export async function runDepartment(config,minutes,signal) {
  const {role,python,directory,env}=config;
  let failures=0,lastCode=0,completedCycles=0,failedCycles=0;
  const deadline=Date.now()+(minutes?minutes*60_000:110_000);
  const controller=new AbortController(),abort=()=>controller.abort();
  signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  const session=new DepartmentSession(config.transport,{onLost:abort});
  try{
    if(!controller.signal.aborted)await session.start();
    do {
      if(controller.signal.aborted)break;
      await session.pulse({state:'running'});
      const timeout=Math.min(110_000,deadline-Date.now());
      if(timeout<=0||controller.signal.aborted)break;
      lastCode=await new Promise(resolve=>{
        const child=spawn(python,['department.py',role],{cwd:directory,env,windowsHide:true,stdio:'inherit',shell:false});
        const stop=()=>child.kill();controller.signal.addEventListener('abort',stop,{once:true});
        if(controller.signal.aborted)stop();
        const timer=setTimeout(()=>{console.error(`${role} cycle deadline reached; unfinished leases expire through normal recovery.`);child.kill();},timeout);
        let failed=false;
        child.once('error',()=>{failed=true;console.error(`${role} process could not start.`);});
        child.once('close',code=>{clearTimeout(timer);controller.signal.removeEventListener('abort',stop);resolve(failed?1:code??1);});
      });
      if(controller.signal.aborted)break;
      if(lastCode===0)completedCycles++;else failedCycles++;
      failures=lastCode===0?0:failures+1;
      await session.pulse({state:lastCode===0?'waiting':'degraded',completedCycles,failedCycles});
      if(!minutes||failures>=3)break;
      const pause=Math.min(lastCode===0?(role==='researcher'?15_000:60_000):120_000,deadline-Date.now());
      if(pause>0)await delay(pause,undefined,{signal:controller.signal}).catch(error=>{if(error.name!=='AbortError')throw error;});
    }while(!controller.signal.aborted&&Date.now()<deadline);
  }catch(error){lastCode=1;console.error(`${role} supervisor stopped: ${error.message}`);}
  finally{
    signal.removeEventListener('abort',abort);
    try{await session.stop();}catch{lastCode=1;console.error(`${role} final status could not be confirmed; its server lease will expire.`);}
  }
  return signal.aborted?130:session.lost?1:lastCode;
}
