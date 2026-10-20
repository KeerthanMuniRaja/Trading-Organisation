import test from 'node:test';
import assert from 'node:assert/strict';
import { importReplay } from './import-replay-evidence.mjs';
const id = '11111111-1111-4111-8111-111111111111';
const options = { mode: 'evidence', run: 'fixture', sourceId: 'internal-research' };
const env = { API_URL: 'http://127.0.0.1:3000', PRINCIPALS_JSON: JSON.stringify([{ role: 'researcher', token: 'fixture-token' }]) };
const bundle = { evidence: { sourceId: options.sourceId, kind: 'dataset', content: 'Synthetic research observation', publishedAt: '2025-01-01T00:00:00Z' }, lessonContent: 'Sample-specific synthetic finding.' };
const prepare = async () => structuredClone(bundle);

test('lost acknowledgement is retried with identical payload and key without review routes', async () => {
  const calls = [];
  const transport = async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) throw Error('fixture-token');
    return { ok: true, json: async () => ({ id, status: 'unverified' }) };
  };
  await assert.rejects(importReplay(options, env, transport, prepare), /not acknowledged/);
  assert.equal((await importReplay(options, env, transport, prepare)).reviewRequired, true);
  assert.equal(calls[0].init.body, calls[1].init.body);
  assert.deepEqual(calls[0].init.headers, calls[1].init.headers);
  assert.ok(calls.every(c => c.url.pathname === '/v1/evidence' && c.init.redirect === 'error'));
});
test('bad origins, roles and preparation errors send no credentials', async () => {
  let requests = 0;
  const transport = async () => { requests++; throw Error('must not send'); };
  for (const API_URL of ['http://example.org', 'https://user:secret@example.org', 'https://example.org/path'])
    await assert.rejects(importReplay(options, { ...env, API_URL }, transport, prepare));
  await assert.rejects(importReplay(options, { ...env, PRINCIPALS_JSON: '[]' }, transport, prepare));
  await assert.rejects(importReplay(options, env, transport, async () => { throw Error('tampered'); }));
  assert.equal(requests, 0);
});
test('lesson import preserves evidence-before-lesson sequencing and cannot approve', async () => {
  const calls = [];
  const result = await importReplay({ ...options, mode: 'lesson', botId: 'student' }, env, async (url, init) => {
    calls.push({ route: url.pathname, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ id, status: 'unverified' }) };
  }, prepare);
  assert.deepEqual(calls.map(c => c.route), ['/v1/evidence', '/v1/lessons']);
  assert.equal(calls[1].body.evidenceId, id);
  assert.equal(result.qualificationChanged, false);
});
test('actual backend requires independent evidence and lesson review; revocation removes knowledge', async () => {
  const { fixture, owner, researcher, evaluator, key } = await import('../backend/dist/test/helpers.js');
  const { createApp } = await import('../backend/dist/src/app.js');
  const f = await fixture();
  const app = await createApp(f.cfg, f.db, true);
  try {
    await app.listen(0, '127.0.0.1');
    const localEnv = { API_URL: await app.getUrl(), PRINCIPALS_JSON: JSON.stringify(f.cfg.principals.filter(p => p.role === 'researcher')) };
    await f.org.sources(owner, key(), { id: options.sourceId, name: 'Internal replay fixture', url: 'https://example.org/research', approved: true });
    await f.org.bot(owner, key(), { id: 'student', name: 'Fixture student', department: 'research', specialty: 'replay', method: 'baseline', contribution: 'Synthetic integration test', budgetPaise: '0' });
    const received = await importReplay(options, localEnv, fetch, prepare);
    await assert.rejects(importReplay({ ...options, mode: 'lesson', botId: 'student' }, localEnv, fetch, prepare), /not acknowledged/);
    await assert.rejects(f.org.reviewEvidence({ ...researcher, role: 'evaluator' }, key(), { evidenceId: received.evidenceId, status: 'verified' }), /Authors cannot/);
    await f.org.reviewEvidence(evaluator, key(), { evidenceId: received.evidenceId, status: 'verified' });
    const proposed = await importReplay({ ...options, mode: 'lesson', botId: 'student' }, localEnv, fetch, prepare);
    assert.equal((await f.org.knowledge(owner)).lessons.length, 0);
    await f.org.verifyLesson(evaluator, key(), { lessonId: proposed.lessonId });
    assert.equal((await f.org.knowledge(owner)).lessons.length, 1);
    const duplicate = await importReplay({ ...options, mode: 'lesson', botId: 'student' }, localEnv, fetch, prepare);
    assert.equal(duplicate.lessonId, proposed.lessonId);
    assert.equal((await f.org.list(owner))[0].state, 'school');
    await f.org.revoke(owner, key(), { kind: 'source', targetId: options.sourceId, reason: 'Fixture withdrawn' });
    assert.equal((await f.org.knowledge(owner)).lessons.length, 0);
  } finally { await app.close(); await f.db.close(); }
});
