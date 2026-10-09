import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseDraft, prepareLesson, validateSnapshot, submitLesson } from './obsidian-lessons.mjs';
const id = '11111111-1111-4111-8111-111111111111';
const text = `---\ntype: nexus-lesson\nstatus: draft\nbotId: student\nevidenceId: ${id}\n---\nThis sample needs cost checks.\n`;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'nexus-note-'));
  await mkdir(join(root, '.obsidian')); await mkdir(join(root, 'Nexus', 'Notes'), { recursive: true });
  await writeFile(join(root, 'Nexus', 'Notes', 'lesson.md'), text);
  const prepared = await prepareLesson(root, 'lesson.md', join(root, 'snapshots'));
  return { root, prepared, snapshot: JSON.parse(await readFile(prepared.snapshot, 'utf8')) };
}
test('strict drafts cannot declare approval or extra permissions', () => {
  assert.equal(parseDraft(text).evidenceId, id);
  for (const value of [text.replace('status: draft', 'status: verified'), text.replace('status: draft', 'status: draft\npermissions: all'), text.replace(id, 'missing')]) assert.throws(() => parseDraft(value));
});
test('preparation is idempotent, bounded to Notes and detects snapshot edits', async () => {
  const { root, prepared, snapshot } = await fixture();
  assert.equal((await prepareLesson(root, 'lesson.md', join(root, 'snapshots'))).snapshot, prepared.snapshot);
  for (const note of ['../Library/secret.md', '/outside.md', 'C:\\secret.md']) await assert.rejects(prepareLesson(root, note, join(root, 'snapshots')));
  snapshot.body.content = 'tampered'; assert.throws(() => validateSnapshot(snapshot));
});
test('submission uses only lesson endpoint and reuses key after lost acknowledgement', async () => {
  const { snapshot } = await fixture();
  const calls = [], env = { PRINCIPALS_JSON: JSON.stringify([{ role: 'researcher', token: 'fixture' }]) };
  const transport = async (url, options) => {
    calls.push({ url, options }); if (calls.length === 1) throw Error('lost');
    return { ok: true, json: async () => ({ id }) };
  };
  await assert.rejects(submitLesson(snapshot, env, transport));
  assert.equal((await submitLesson(snapshot, env, transport)).reviewRequired, true);
  assert.deepEqual(calls[0].options.headers, calls[1].options.headers);
  assert.equal(calls[0].options.body, calls[1].options.body);
  assert.ok(calls.every(c => c.url.pathname === '/v1/lessons' && c.options.redirect === 'error'));
});
