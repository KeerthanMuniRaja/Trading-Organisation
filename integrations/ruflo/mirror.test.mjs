import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBackendClient, mirrorOnce, validateTasks, BackendFailure } from './mirror.mjs';
import { inspectRuntime, validateIdentity } from './runtime.mjs';
import { RufloCoordinator } from './coordinator.mjs';

const task = (id = 'exp1', state = 'queued') => ({ id, bot_id: 'bot-one', hypothesis: 'Study a synthetic fixture', state, created_at: '2026-10-03T00:00:00.000Z' });
const token = 'a'.repeat(43);

test('feed validation rejects extra data, duplicate IDs and malformed tasks before opening MCP', async () => {
  for (const feed of [[{ ...task(), holdout: [] }], [task(), task()], [{ ...task(), state: 'live' }], [{ ...task(), hypothesis: '\u0000' }]]) {
    let opened = false;
    await assert.rejects(mirrorOnce({ client: { tasks: async () => feed }, openCoordinator: async () => { opened = true; } }), /Invalid coordination/);
    assert.equal(opened, false);
  }
  assert.throws(() => validateTasks(Array.from({ length: 101 }, (_, i) => task('exp' + i))));
});

test('mirror batches calls, bounds long descriptions and accepts only application terminal states', async () => {
  const tasks = Array.from({ length: 60 }, (_, i) => ({ ...task('exp' + i, i % 2 === 0 ? 'passed' : 'rejected'), hypothesis: 'A'.repeat(4000) }));
  const sessions = [];
  const result = await mirrorOnce({ client: { tasks: async () => tasks }, openCoordinator: async () => {
    const session = { calls: 0, closed: false }; sessions.push(session);
    return {
      async createResearchTask(id, summary) { session.calls++; assert.ok(summary.length <= 2000); assert.match(summary, /SHA-256:/); return { reused: false }; },
      async completeResearchTask(id, value) { session.calls++; assert.equal(value.resultReference, 'experiment:' + id); assert.ok(['completed', 'rejected'].includes(value.outcome)); return { reused: false }; },
      async close() { session.closed = true; },
    };
  } });
  assert.deepEqual(result, { taskCount: 60, created: 60, completed: 60 });
  assert.equal(sessions.length, 3);
  assert.ok(sessions.every(s => s.closed && s.calls <= 50));
});

test('mirror closes its session and does not retry an uncertain upstream write', async () => {
  let calls = 0, closed = false;
  await assert.rejects(mirrorOnce({ client: { tasks: async () => [task()] }, openCoordinator: async () => ({
    async createResearchTask() { calls++; throw new Error('Unknown outcome'); },
    async close() { closed = true; },
  }) }), /Unknown outcome/);
  assert.equal(calls, 1); assert.equal(closed, true);
});

test('empty feed still verifies an actual coordinator session before claiming healthy', async () => {
  let opened = 0;
  await mirrorOnce({ client: { tasks: async () => [] }, openCoordinator: async () => { opened++; return { async close() {} }; } });
  assert.equal(opened, 1);
});

test('HTTP client retries temporary failures without following redirects or changing payload', async () => {
  const calls = [];
  const client = createBackendClient({ base: 'http://127.0.0.1:1234', token, delay: async () => {}, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return calls.length < 3 ? new Response('{}', { status: 503 }) : new Response('{"recorded":true}');
  } });
  const status = { state: 'degraded', code: 'MCP_UNAVAILABLE', taskCount: 0 };
  assert.deepEqual(await client.status(status), { recorded: true });
  assert.equal(calls.length, 3);
  assert.ok(calls.every(c => c.options.redirect === 'error' && c.options.body === JSON.stringify(status)));
});

test('HTTP permission failures and oversized responses fail without retrying', async () => {
  for (const response of [() => new Response('{}', { status: 403 }), () => new Response('x'.repeat(1024 * 1024 + 1))]) {
    let calls = 0;
    const client = createBackendClient({ base: 'http://127.0.0.1:1234', token, fetchImpl: async () => { calls++; return response(); } });
    await assert.rejects(client.tasks(), e => e instanceof BackendFailure && !e.retryable);
    assert.equal(calls, 1);
  }
});

test('client rejects unsafe origins and stops when aborted', async () => {
  for (const base of ['http://example.org', 'https://user:secret@example.org', 'https://example.org/path', 'https://example.org/?key=secret']) assert.throws(() => createBackendClient({ base, token }));
  const controller = new AbortController(); controller.abort();
  const client = createBackendClient({ base: 'http://127.0.0.1', token, signal: controller.signal, fetchImpl: async () => { assert.fail('No request after cancellation'); } });
  await assert.rejects(client.tasks(), /abort/i);
});

test('runtime diagnoses prerequisites before writing a task intent', async () => {
  assert.equal(validateIdentity({ username: 'worker', homedir: tmpdir() }), true);
  assert.equal(validateIdentity({ username: '', homedir: tmpdir() }), false);
  assert.equal(validateIdentity({ username: 'worker', homedir: 'relative' }), false);
  const report = await inspectRuntime();
  assert.equal(report.ready, report.checks.every(c => c.ok));
  if (!report.ready) {
    const stateDir = await mkdtemp(join(tmpdir(), 'ruflo-preflight-'));
    await assert.rejects(RufloCoordinator.open({ stateDir }), e => e.code === report.code);
    assert.deepEqual(await readdir(stateDir), []);
  }
});
