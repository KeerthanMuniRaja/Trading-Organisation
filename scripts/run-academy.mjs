import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = path.join(root, 'integrations', 'skfolio');
const python = path.join(dir, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
if (!existsSync(python)) throw new Error('Install the isolated academy environment first; see docs/portfolio-academy.md');
const mode = process.argv[2];
if (!['run', 'test'].includes(mode) || process.argv.length !== 3) throw new Error('Use run or test without additional arguments');
const env = {};
for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'HOME']) {
  if (process.env[key]) env[key] = process.env[key];
}
Object.assign(env, { PYTHONNOUSERSITE: '1', OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1', MKL_NUM_THREADS: '1' });
const args = mode === 'test' ? ['-m', 'unittest', '-v', 'test_lab.py', 'test_bridge.py', 'test_skills.py'] : ['lab.py'];
const child = spawn(python, args, { cwd: dir, env, windowsHide: true, stdio: 'inherit' });
// This worker spawns no child processes. A terminated fit resumes from its journal.
const timer = setTimeout(() => { console.error('Academy reached its 10-minute session limit. Rerun to resume.'); child.kill(); }, 600_000);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill());
child.on('error', error => { clearTimeout(timer); console.error(error.message); process.exitCode = 1; });
child.on('exit', (code) => { clearTimeout(timer); process.exitCode = code ?? 1; });
