import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PRELOAD = pathToFileURL(join(ROOT, 'scripts', 'replay-clock.mjs')).href;
const PY = join(ROOT, '.local', 'replay-venv', ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']));

function node(code, env) {
  return execFileSync(process.execPath, ['--import', PRELOAD, '--input-type=module', '-e', code],
    { env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

test('a Node process lives at the replay time, the database follows, and the live database is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'replay-clock-'));
  try {
    const clock = join(dir, 'clock.json');
    await writeFile(clock, JSON.stringify({ now: '2024-03-15T10:00:00Z' }));
    const env = { REPLAY_CLOCK_FILE: clock, DATABASE_PATH: join(dir, 'replay-db') };
    const out = JSON.parse(node(`console.log(JSON.stringify({ now: new Date().toISOString(), ms: Date.now(), str: typeof Date(),
      inst: new Date() instanceof Date, fixed: new Date('2020-01-01T00:00:00Z').toISOString() }))`, env));
    assert.match(out.now, /^2024-03-15T10:00:0/);
    assert.ok(Math.abs(out.ms - Date.parse('2024-03-15T10:00:00Z')) < 60_000);
    assert.deepEqual([out.str, out.inst, out.fixed], ['string', true, '2020-01-01T00:00:00.000Z']);  // explicit dates are untouched
    // the embedded database's now() follows the same clock
    const pglite = pathToFileURL(join(ROOT, 'node_modules', '@electric-sql', 'pglite', 'dist', 'index.js')).href;
    const sql = node(`const { PGlite } = await import('${pglite}'); const db = new PGlite();
      console.log((await db.query("SELECT (now() AT TIME ZONE 'UTC')::date::text AS d")).rows[0].d); await db.close();`, env);
    assert.equal(sql, '2024-03-15');
    // never the live database
    assert.throws(() => node('console.log(1)', { REPLAY_CLOCK_FILE: clock, DATABASE_PATH: '.data/paper' }), /refused/);
    assert.throws(() => node('console.log(1)', { REPLAY_CLOCK_FILE: join(dir, 'missing.json'), DATABASE_PATH: join(dir, 'replay-db') }), /refused/);
    // without the variable nothing changes
    assert.ok(Number(execFileSync(process.execPath, ['--import', PRELOAD, '-e', 'console.log(new Date().getFullYear())'],
      { env: { ...process.env, REPLAY_CLOCK_FILE: '' }, encoding: 'utf8' })) >= 2026);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a Python desk script lives at the replay time too, and only inside a replay workspace', { skip: !existsSync(PY) }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'replay-ws-'));
  try {
    const clock = join(dir, 'clock.json');
    await writeFile(clock, JSON.stringify({ now: '2024-03-15T10:00:00Z' }));
    const env = { ...process.env, REPLAY_CLOCK_FILE: clock, PYTHONPATH: join(ROOT, 'integrations', 'replay') };
    const code = 'from datetime import datetime, timezone, date; import time; print(datetime.now(timezone.utc).date(), date.today(), int(time.time()) // 86400)';
    const out = execFileSync(PY, ['-c', code], { env, cwd: dir, encoding: 'utf8' }).trim().split(' ');
    assert.deepEqual(out.slice(0, 2), ['2024-03-15', '2024-03-15']);
    assert.equal(Number(out[2]), Math.floor(Date.parse('2024-03-15T10:00:00Z') / 86_400_000));
    const live = join(dir, '..', 'not-a-workspace-' + Date.now());
    await mkdir(live, { recursive: true });
    try {
      assert.throws(() => execFileSync(PY, ['-c', 'print(1)'], { env, cwd: live, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    } finally { await rm(live, { recursive: true, force: true }); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
