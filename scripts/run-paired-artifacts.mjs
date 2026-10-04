import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { prepareDepartment } from './department-runtime.mjs';

// Reuse scoped credential selection without starting recurring department work.
const config=prepareDepartment('researcher');
const child=spawn(config.python,[join(config.directory,'artifact_executor.py'),...process.argv.slice(2)],
  {cwd:process.cwd(),env:config.env,windowsHide:true,shell:false,stdio:'inherit'});
child.once('error',()=>{console.error('Could not start the local artifact executor.');process.exitCode=1;});
child.once('close',code=>{process.exitCode=code??1;});
