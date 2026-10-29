// Handover (OPS-04): move the organisation to another machine safely. Run on the machine it runs on NOW, before
// setting it up elsewhere (scripts/setup-machine.ps1 there). In order, stopping at the first problem:
//   1. wait for any running supervisor job to finish, then stop the supervisor
//   2. refuse while the backend is still running (a backup needs the database closed)
//   3. take a verified backup, export the data and push the private data repository
//   4. push the code branch dev (never main)
//   5. mark this machine handed over: its supervisor then refuses to start (supervisor --take-back to undo)
// Run the organisation on one machine only: two machines grow two databases that cannot be merged.
//   npm run handover -- --to "home EliteBook"
//   npm run handover -- --check      what it would find (supervisor, backend, secrets, uncommitted code); changes nothing
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const HEARTBEAT = join(root, '.local', 'supervisor', 'heartbeat.json');

// The owner's secret backup in the private data repository ("DO NOT OPEN"): each file's path on a line of its own,
// then its content, sections separated by two blank lines. The handover refreshes it from the current files (the old
// copy lacked later settings), and setup-machine.ps1 restores the three files from it. Values are never printed.
export const SECRET_FILES = [['owner-signing-key.pem', '.local/owner-signing-key.pem'], ['.env', '.env'], ['.local/credentials.json', '.local/credentials.json']];

export function secretsBundle(contents) {
  return SECRET_FILES.map(([marker]) => `${marker}\n${String(contents[marker]).replace(/\r\n/g, '\n').replace(/\n+$/, '')}\n`).join('\n\n');
}

/** The inverse, for tests and checks: marker -> content. The same rule setup-machine.ps1 applies. */
export function parseBundle(text) {
  const markers = new Set(SECRET_FILES.map(([m]) => m)), out = {};
  let current = null;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (markers.has(line.trim())) { current = line.trim(); out[current] = []; continue; }
    if (current) out[current].push(line);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join('\n').replace(/\n+$/, '') + '\n']));
}

/** Code that `git push origin dev` would leave behind on this machine: uncommitted changes and new files (git status
 *  --porcelain lines, the local data folder is ignored). */
export function leftBehind(porcelain) {
  return String(porcelain ?? '').split('\n').map(l => l.replace(/\r$/, '')).filter(l => l.trim()).map(l => l.slice(3));
}

/** --check (29 Oct 2026): what the handover would find, changing nothing. Ready only when nothing would stop it. */
export function preview({ beat, backendUp, secrets, porcelain, dataRepo, now = Date.now() }) {
  const s = supervisorState(beat, now), left = leftBehind(porcelain);
  const blockers = [...(backendUp && s.state === 'none' ? ['the backend runs without the supervisor: stop it first'] : []),
    ...secrets.filter(([, present]) => !present).map(([path]) => `missing ${path} (the secret backup needs it)`),
    ...(dataRepo ? [] : ['no data repository at .local/data-repo'])];
  return { ready: blockers.length === 0, blockers,
    supervisor: s.state === 'busy' ? `busy with "${s.running}": the handover waits for it` : s.state === 'idle' ? 'idle: the handover stops it' : 'not running',
    uncommittedCode: left, ...(left.length ? { warning: `${left.length} uncommitted code change(s) would stay on this machine; commit them first` } : {}) };
}

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
  const porcelain = sh('git', ['status', '--porcelain']).stdout;
  if (process.argv.includes('--check')) {
    const backendUp = await fetch('http://127.0.0.1:3000/v1/health', { signal: AbortSignal.timeout(3000) }).then(r => r.ok, () => false);
    console.log(JSON.stringify(preview({ beat: readBeat(), backendUp, porcelain, dataRepo: existsSync(join(root, '.local', 'data-repo', '.git')),
      secrets: SECRET_FILES.map(([, path]) => [path, existsSync(join(root, path))]) }), null, 2));
    return;
  }
  for (const file of leftBehind(porcelain)) say(`WARNING: not committed, stays on this machine: ${file}`);
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
  // 3. the secret backup refreshed from the current files (never printed), then backup, export, data repository
  if (!process.argv.includes('--keep-secret-backup')) {
    const contents = Object.fromEntries(SECRET_FILES.map(([marker, path]) => [marker, readFileSync(join(root, path), 'utf8')]));
    const bundle = secretsBundle(contents);
    const back = parseBundle(bundle);
    if (SECRET_FILES.some(([m]) => back[m] !== contents[m].replace(/\r\n/g, '\n').replace(/\n+$/, '') + '\n')) throw new Error('The secret backup would not restore exactly; nothing was written');
    await writeFile(join(root, '.local', 'data-repo', 'DO NOT OPEN'), bundle);
    say('secret backup refreshed from the current three files (contents not shown)');
  }
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
