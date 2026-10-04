import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
const directory=join(root,'integrations','skfolio');
const python=join(directory,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const env=Object.fromEntries(['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
const child=spawn(python,[join(directory,'verify_artifact_sandbox.py'),...process.argv.slice(2)],
  {cwd:root,env,windowsHide:true,shell:false,stdio:'inherit'});
child.once('error',()=>{console.error('Could not start sandbox verification.');process.exitCode=1;});
child.once('close',code=>{process.exitCode=code??1;});
