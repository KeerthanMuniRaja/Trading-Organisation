import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const python = join(root, '.local', 'replay-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
if (!existsSync(python)) {
  console.error('Project-local replay environment missing; see docs/historical-replay.md.');
  process.exit(1);
}
const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
env.PYTHONNOUSERSITE = '1'; env.PYTHONIOENCODING = 'utf-8';
const child = spawn(python, [join(root, 'integrations/market-replay/replay.py'), ...process.argv.slice(2)], {
  cwd: root, env, windowsHide: true, shell: false, stdio: 'inherit'
});
const timer = setTimeout(() => { console.error('Replay exceeded its 90-second limit.'); child.kill(); }, 90_000);
child.once('error', () => { clearTimeout(timer); console.error('Replay could not start.'); process.exitCode = 1; });
child.once('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
