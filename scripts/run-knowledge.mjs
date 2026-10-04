import { spawn } from 'node:child_process';
import { prepareDepartment } from './department-runtime.mjs';

const workflowEvaluator=process.argv[2]==='workflow-run'&&process.argv[process.argv.indexOf('--role')+1]==='evaluator';
const review=workflowEvaluator||['review','assessment-create','assessment-grade','source-review'].includes(process.argv[2]);
const config=prepareDepartment(review?'evaluator':'researcher');
if(!review)for(const name of ['HERMES_ENABLED','HERMES_SOURCE_PATH','HERMES_PYTHON','HERMES_MODEL','HERMES_MODEL_BASE_URL','HERMES_MODEL_API_KEY'])
  if(process.env[name])config.env[name]=process.env[name];
const child=spawn(config.python,['integrations/hermes/knowledge_worker.py',...process.argv.slice(2)],
  {cwd:process.cwd(),env:config.env,windowsHide:true,shell:false,stdio:'inherit'});
child.once('error',()=>{console.error('Knowledge worker could not start');process.exitCode=1;});
child.once('close',code=>{process.exitCode=code??1;});
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>child.kill(signal));
