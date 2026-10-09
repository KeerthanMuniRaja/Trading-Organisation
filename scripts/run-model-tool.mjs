import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Model endpoint tools receive only model settings: no organisation API token or principal list.
const tools = { doctor: 'model_doctor.py', benchmark: 'model_benchmark.py', practice: 'practice_benchmark.py' };
const [tool, ...args] = process.argv.slice(2);
if (!tools[tool]) { console.error('Usage: run-model-tool.mjs doctor|benchmark|practice [options]'); process.exit(1); }
const root = fileURLToPath(new URL('../', import.meta.url));
const localPython = join(root, 'integrations', 'skfolio', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const python = process.env.PYTHON_BIN ?? (existsSync(localPython) ? localPython : (process.platform === 'win32' ? 'python' : 'python3'));
const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
Object.assign(env, { PYTHONIOENCODING: 'utf-8', PYTHONNOUSERSITE: '1' });
for (const name of ['HERMES_ENABLED', 'HERMES_SOURCE_PATH', 'HERMES_PYTHON', 'HERMES_MODEL', 'HERMES_MODEL_BASE_URL', 'HERMES_MODEL_API_KEY', 'HERMES_TIMEOUT_SECONDS'])
  if (process.env[name]) env[name] = process.env[name];
const child = spawn(python, [join('integrations', 'hermes', tools[tool]), ...args], { cwd: root, env, windowsHide: true, stdio: 'inherit', shell: false });
// A practice experiment is finite even if a provider trickles a stalled response.
const practiceTimer = tool === 'practice' ? setTimeout(() => { console.error('Practice experiment exceeded 360 seconds'); child.kill(); }, 360000) : null;
child.once('close', () => { if (practiceTimer) clearTimeout(practiceTimer); });
child.once('error', () => { console.error('Model tool could not start'); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
