import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
const args=process.argv.slice(2),role=args[0];
if(!['researcher','evaluator'].includes(role))throw new Error('Choose researcher or evaluator');
const principal=JSON.parse(process.env.PRINCIPALS_JSON??'[]').find(p=>p.role===role);
if(!principal)throw new Error(`Configure a scoped ${role} principal`);
const directory=path.join(root,'integrations','skfolio');
const python=path.join(directory,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
if(!existsSync(python))throw new Error('Install the academy environment first; see docs/portfolio-academy.md');
const env=Object.fromEntries(['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
Object.assign(env,{API_URL:process.env.API_URL??'http://127.0.0.1:3000',API_TOKEN:principal.token,
  PYTHONNOUSERSITE:'1',PYTHONIOENCODING:'utf-8',OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1',MKL_NUM_THREADS:'1'});
const child=spawn(python,['bridge.py',...args],{cwd:directory,env,windowsHide:true,stdio:'inherit',shell:false});
const timeout=setTimeout(()=>{console.error('Portfolio worker reached its two-minute deadline; rerun the same request to recover.');child.kill();},120_000);
child.on('error',error=>{clearTimeout(timeout);console.error(error.message);process.exitCode=1;});
child.on('exit',code=>{clearTimeout(timeout);process.exitCode=code??1;});
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>child.kill());
