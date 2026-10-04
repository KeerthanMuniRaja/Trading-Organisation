import { duration, prepareDepartment, runDepartment } from './department-runtime.mjs';
const [role,...args]=process.argv.slice(2);
const minutes=duration(args),config=prepareDepartment(role),controller=new AbortController();
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>controller.abort());
process.exitCode=await runDepartment(config,minutes,controller.signal);
