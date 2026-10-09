import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { renderOrganisation, captureOrganisation } from './obsidian-organisation.mjs';
const bots = [{ id: 'student', name: '[[Injected]]', state: 'school', department: 'research', specialty: 'costs', token: 'DO_NOT_EXPORT' }];
const knowledge = { evidence: [{ id: 'e1', status: 'verified', content: 'PRIVATE_SOURCE' }], lessons: [{ id: 'l1', bot_id: 'student', evidence_id: 'e1', content: 'PRIVATE_LESSON' }] };
test('graph links only included records and excludes raw content and extra fields', () => {
  const notes = renderOrganisation(bots, knowledge, 'Nexus/Organisation/run', {});
  const all = [...notes.values()].join('\n');
  for (const secret of ['DO_NOT_EXPORT', 'PRIVATE_SOURCE', 'PRIVATE_LESSON', '[[Injected]]']) assert.ok(!all.includes(secret));
  assert.ok(notes.get('Lesson-l1.md').includes('[[Nexus/Organisation/run/Bot-student]]'));
  assert.ok(notes.get('Lesson-l1.md').includes('[[Nexus/Organisation/run/Evidence-e1]]'));
  assert.throws(() => renderOrganisation([{ id: '../escape' }], knowledge, 'x', {}));
  const missing = renderOrganisation([], knowledge, 'x', {});
  assert.ok(missing.get('Lesson-l1.md').includes('Not included'));
});
test('capture makes only bounded GET requests and saves completion marker last', async () => {
  const vault = await mkdtemp(join(tmpdir(), 'nexus-org-view-'));
  await mkdir(join(vault, '.obsidian'));
  const calls = [], env = { PRINCIPALS_JSON: JSON.stringify([{ role: 'researcher', token: 'test' }]) };
  const result = await captureOrganisation(vault, env, async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(url.pathname === '/v1/bots' ? bots : knowledge));
  });
  assert.deepEqual(calls.map(c => [c.url.pathname, c.options.method, c.options.redirect]), [['/v1/bots', 'GET', 'error'], ['/v1/knowledge', 'GET', 'error']]);
  assert.equal(JSON.parse(await readFile(join(dirname(result.index), 'complete.json'), 'utf8')).backendModified, false);
  await assert.rejects(captureOrganisation(vault, { ...env, API_URL: 'http://example.org' }, () => assert.fail('must not send')));
});
