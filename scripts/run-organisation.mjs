import { duration, prepareDepartment, runDepartment } from './department-runtime.mjs';
const minutes=duration(process.argv.slice(2),{required:true});
// The parent owns both Python processes directly, including shutdown.
const configs=['researcher','evaluator'].map(prepareDepartment),controller=new AbortController();
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>controller.abort());
console.log(JSON.stringify({event:'organisation.session.started',minutes,roles:configs.map(c=>c.role),scope:'example-research-and-memory'}));
const results=await Promise.all(configs.map(async config=>{
  let code;
  try{code=await runDepartment(config,minutes,controller.signal);}
  catch{code=1;console.error(`${config.role} supervisor failed; stopping the team session.`);}
  if(code!==0&&code!==130)controller.abort();
  return {role:config.role,code};
}));
process.exitCode=results.find(r=>r.code!==0&&r.code!==130)?.code??(controller.signal.aborted?130:0);
console.log(JSON.stringify({event:'organisation.session.stopped',results}));
