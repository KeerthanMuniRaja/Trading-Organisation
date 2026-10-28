// Handover (OPS-04): move the organisation to another machine safely. Run on the machine it runs on NOW, before
// setting it up elsewhere (scripts/setup-machine.ps1 there). In order, stopping at the first problem:
//   1. wait for any running supervisor job to finish, then stop the supervisor
//   2. refuse while the backend is still running (a backup needs the database closed)
//   3. take a verified backup, export the data and push the private data repository
//   4. push the code branch dev (never main)
//   5. mark this machine handed over: its supervisor then refuses to start (supervisor --take-back to undo)
// Run the organisation on one machine only: two machines grow two databases that cannot be merged.
//   npm run handover -- --to "home EliteBook"
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const HEARTBEAT = join(root, '.local', 'supervisor', 'heartbeat.json');

/** What the supervisor is doing: 'none' (no live heartbeat), 'idle' or 'busy'. Its heartbeat beats every minute. */
export function supervisorState(beat, now = Date.now()) {
  if (!beat || now - Date.parse(beat.at) > 5 * 60_000) return { state: 'none' };
  return { state: beat.running ? 'busy' : 'idle', pid: beat.pid, running: beat.running ?? null };
}

// npm needs a shell on Windows; git does not, and must not get one (a shell would split a commit message at its spaces)
const sh = (cmd, args, cwd = root) => spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 30 * 60_000,
  shell: process.platform === 'win32' && cmd === 'npm' });
const say = s => console.error('handover: ' + s);
const readBeat = () => { try { return JSON.parse(readFileSync(HEARTBEAT, 'utf8')); } catch { return null; } };

async function main() {
  const to = (() => { const i = process.argv.indexOf('--to'); return i > 0 ? process.argv[i + 1] : 'another machine'; })();
  // 1. the supervisor: wait out a running job (the cycle can take an hour or more), then stop it
  for (let s = supervisorState(readBeat()); s.state === 'busy'; s = supervisorState(readBeat())) {
    say(`the supervisor is running "${s.running}"; waiting for it to finish (checks every minute; Ctrl+C to stop)`);
    await new Promise(r => setTimeout(r, 60_000));
  }
  const s = supervisorState(readBeat());
  if (s.state === 'idle') {
    try { process.kill(s.pid); say(`stopped the supervisor (pid ${s.pid})`); } catch { say('the supervisor had already stopped'); }
  }
  // 2. the backend must be down for a consistent backup
  const api = await fetch('http://127.0.0.1:3000/v1/health', { signal: AbortSignal.timeout(3000) }).then(r => r.ok, () => false);
  if (api) throw new Error('The backend is still running. Stop it (close its window, or stop "npm start"), then run the handover again');
  // 3. backup, export, data repository
  for (const [what, cmd, args, cwd] of [
    ['backup', 'npm', ['run', 'backup', '--', 'create']],
    ['export', 'npm', ['run', 'export-data', '--', '--write']],
    ['data add', 'git', ['add', '-A'], join(root, '.local', 'data-repo')],
    ['data commit', 'git', ['commit', '-q', '-m', `Handover to ${to}: backup and export`], join(root, '.local', 'data-repo')],
    ['data push', 'git', ['push'], join(root, '.local', 'data-repo')],
    ['code push (dev)', 'git', ['push', 'origin', 'dev']]]) {
    const r = sh(cmd, args, cwd);
    const nothing = what === 'data commit' && /nothing to commit/.test(`${r.stdout}${r.stderr}`);
    if (r.status !== 0 && !nothing) throw new Error(`${what} failed: ${`${r.stderr}${r.stdout}`.trim().split('\n').slice(-2).join(' ')}`);
    say(`${what}: done`);
  }
  // 5. this machine no longer runs the organisation
  await writeFile(join(root, '.local', 'handover.json'), JSON.stringify({ at: new Date().toISOString(), to }, null, 2) + '\n');
  console.log(JSON.stringify({ state: 'handed-over', to, next: `On ${to}: pull both repositories, then run scripts\\setup-machine.ps1` }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error('handover: ' + error.message); process.exitCode = 1; });
}
