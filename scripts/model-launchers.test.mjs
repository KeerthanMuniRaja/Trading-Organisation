import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('real launchers preserve the selected engine only for inference roles', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'model-launcher-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Intercept the child boundary before loading the real launcher. No Python,
  // model or backend is started, and only fixture credentials enter the process.
  const hook = join(directory, 'capture.mjs');
  await writeFile(hook, `
import cp from 'node:child_process';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
fs.existsSync = () => true;
cp.spawn = (executable, args, options) => {
  console.log(JSON.stringify({ args, env: options.env, shell: options.shell }));
  const child = new EventEmitter(); child.kill = () => true;
  process.nextTick(() => { child.emit('exit', 0); child.emit('close', 0); });
  return child;
};
syncBuiltinESMExports();
`);
  const root = fileURLToPath(new URL('../', import.meta.url));
  const env = Object.fromEntries(['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'Path']
    .filter(k => process.env[k]).map(k => [k, process.env[k]]));
  Object.assign(env, { PRINCIPALS_JSON: JSON.stringify([
    { role: 'researcher', token: 'research-fixture' }, { role: 'evaluator', token: 'evaluation-fixture' },
    { role: 'owner', token: 'owner-fixture' }]), HERMES_ENABLED: 'true', HERMES_ENGINE: 'direct',
    HERMES_MODEL: 'fixture-model', HERMES_MODEL_BASE_URL: 'http://127.0.0.1:9999/v1',
    HERMES_MODEL_API_KEY: 'model-fixture', HERMES_TIMEOUT_SECONDS: '300',
    OWNER_PRIVATE_KEY: 'owner-key-fixture', DATABASE_URL: 'database-fixture' });
  for (const [script, args, inference, role] of [
    ['run-knowledge.mjs', ['learn'], true, 'research'],
    ['run-knowledge.mjs', ['workflow-run', '--role', 'researcher'], true, 'research'],
    ['run-knowledge.mjs', ['workflow-run', '--role', 'evaluator'], false, 'evaluation'],
    ['run-knowledge.mjs', ['source-review'], false, 'evaluation'],
    ['run-knowledge.mjs', ['discover'], false, 'research'],
    ['run-development.mjs', [], true, 'research'],
  ]) {
    const child = spawnSync(process.execPath, ['--import', pathToFileURL(hook).href, join(root, 'scripts', script), ...args],
      { cwd: root, env, encoding: 'utf8', timeout: 10000, windowsHide: true, shell: false });
    assert.equal(child.status, 0, child.stderr);
    const captured = JSON.parse(child.stdout.trim());
    assert.equal(captured.shell, false);
    assert.equal(captured.env.API_TOKEN, role + '-fixture');
    assert.equal(captured.env.HERMES_ENGINE, inference ? 'direct' : undefined);
    assert.equal(captured.env.HERMES_TIMEOUT_SECONDS, inference ? '300' : undefined);
    assert.equal(captured.env.HERMES_MODEL_API_KEY, inference ? 'model-fixture' : undefined);
    for (const key of ['PRINCIPALS_JSON', 'OWNER_PRIVATE_KEY', 'DATABASE_URL']) assert.equal(captured.env[key], undefined);
  }
});
