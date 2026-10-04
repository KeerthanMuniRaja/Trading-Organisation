import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
process.chdir(root);
const reportPath=join(root,'.local','portfolio-verification.json');
const logs=join(root,'.local','portfolio-verification',new Date().toISOString().replace(/[:.]/g,'-'));
await mkdir(logs,{recursive:true});
const env=Object.fromEntries(['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
const report={status:'running',startedAt:new Date().toISOString(),stages:[]};
let current;
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>current?.kill());
const save=()=>writeFile(reportPath,JSON.stringify(report,null,2));
async function stage(name,args){
  const record={name,status:'running',log:join(logs,name+'.log')};report.stages.push(record);await save();
  console.log(`\n${name}\n`);
  const stream=createWriteStream(record.log,{flags:'wx'});
  try{
    const code=await new Promise((resolve,reject)=>{
      current=spawn(process.execPath,args,{cwd:root,env,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
      const timeout=setTimeout(()=>{current?.kill();reject(new Error(`${name} exceeded ten minutes`));},600_000);
      stream.on('error',error=>{current?.kill();clearTimeout(timeout);reject(error);});
      for(const [source,target] of [[current.stdout,process.stdout],[current.stderr,process.stderr]]){
        source.on('data',chunk=>{target.write(chunk);stream.write(chunk);});
      }
      current.on('error',error=>{clearTimeout(timeout);reject(error);});
      current.on('close',exitCode=>{clearTimeout(timeout);resolve(exitCode);});
    });
    record.status=code===0?'passed':'failed';record.exitCode=code;
    if(code!==0)throw new Error(`${name} failed; see ${record.log}`);
  }catch(error){record.status='failed';record.error=error.message;throw error;}
  finally{current=undefined;await new Promise(resolve=>stream.end(resolve));await save();}
}
try{
  await stage('build',['node_modules/typescript/bin/tsc','-p','backend/tsconfig.json']);
  const tests=(await readdir('backend/dist/test')).filter(name=>name.endsWith('.test.js')).sort().map(name=>'backend/dist/test/'+name);
  if(!tests.length)throw new Error('No compiled backend tests found');
  await stage('backend-tests',['--test','--test-concurrency=1',...tests]);
  await stage('python-academy-tests',['scripts/run-academy.mjs','test']);
  await stage('portfolio-http-integration',['integrations/skfolio/http-check.mjs']);
  report.status='passed';
}catch(error){report.status='failed';report.error=error.message;process.exitCode=1;}
finally{report.finishedAt=new Date().toISOString();await save();console.log(`\nVerification ${report.status}. Saved report: ${reportPath}`);}
