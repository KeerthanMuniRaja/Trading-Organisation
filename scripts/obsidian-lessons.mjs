import { open, lstat, realpath, mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, relative, join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function bounded(file) {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(16385), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 16384) throw Error('Draft exceeds 16 KiB');
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}
export function parseDraft(text) {
  const normalized = text.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(normalized);
  if (!match) throw Error('Expected the Nexus lesson template frontmatter');
  const meta = {};
  for (const line of match[1].split('\n')) {
    const field = /^(type|status|botId|evidenceId): ([A-Za-z0-9_-]+)$/.exec(line);
    if (!field || Object.hasOwn(meta, field[1])) throw Error('Unsupported or duplicate draft property');
    meta[field[1]] = field[2];
  }
  const content = match[2].trim();
  if (meta.type !== 'nexus-lesson' || meta.status !== 'draft' || !/^[A-Za-z0-9_-]{1,80}$/.test(meta.botId ?? '') ||
      !uuid.test(meta.evidenceId ?? '') || !content || content.length > 4000) throw Error('Fill in a valid bot ID, supporting evidence UUID and lesson of 1–4000 characters');
  return { botId: meta.botId, evidenceId: meta.evidenceId, content };
}
export async function prepareLesson(vault, note, output) {
  if (isAbsolute(note) || note.split(/[\\/]/).some(s => !s || s === '.' || s === '..' || s.includes(':')) || !note.endsWith('.md')) throw Error('Supply a Markdown path relative to Nexus/Notes');
  const root = resolve(vault);
  const config = await lstat(join(root, '.obsidian'));
  if (!config.isDirectory() || config.isSymbolicLink()) throw Error('An existing vault is required');
  const notes = join(root, 'Nexus', 'Notes');
  let cursor = root;
  for (const segment of ['Nexus', 'Notes', ...note.split(/[\\/]/)]) {
    cursor = join(cursor, segment);
    if ((await lstat(cursor)).isSymbolicLink()) throw Error('Linked note paths are not allowed');
  }
  if (relative(await realpath(notes), await realpath(cursor)).startsWith('..')) throw Error('Note outside Notes folder');
  const raw = await bounded(cursor), body = parseDraft(raw);
  const snapshot = { version: 1, kind: 'obsidian-lesson-proposal', note, noteSha256: createHash('sha256').update(raw).digest('hex'), body };
  const hash = digest(snapshot);
  await mkdir(output, { recursive: true });
  const destination = join(output, hash + '.json');
  const encoded = JSON.stringify({ ...snapshot, snapshotSha256: hash }, null, 2);
  try { await writeFile(destination, encoded, { flag: 'wx' }); }
  catch (e) { if (e.code !== 'EEXIST' || await readFile(destination, 'utf8') !== encoded) throw Error('Snapshot conflict'); }
  return { snapshot: destination, status: 'prepared-only', body, backendModified: false };
}
export function validateSnapshot(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'body,kind,note,noteSha256,snapshotSha256,version' ||
      value.version !== 1 || value.kind !== 'obsidian-lesson-proposal' || typeof value.note !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.noteSha256)) throw Error('Invalid prepared snapshot');
  const b = value.body;
  if (!b || Object.keys(b).sort().join(',') !== 'botId,content,evidenceId' || typeof b.content !== 'string') throw Error('Invalid lesson body');
  const body = parseDraft(`---\ntype: nexus-lesson\nstatus: draft\nbotId: ${b.botId}\nevidenceId: ${b.evidenceId}\n---\n${b.content}`);
  if (JSON.stringify(body) !== JSON.stringify(b)) throw Error('Noncanonical lesson body');
  const { snapshotSha256, ...snapshot } = value;
  if (snapshotSha256 !== digest(snapshot)) throw Error('Snapshot was changed; prepare the note again');
  return body;
}
export async function submitLesson(snapshot, env = process.env, transport = fetch) {
  const body = validateSnapshot(snapshot);
  const origin = new URL(env.API_URL ?? 'http://127.0.0.1:3000');
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' ||
      !(origin.protocol === 'https:' || (origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)))) throw Error('Invalid API origin');
  const identities = JSON.parse(env.PRINCIPALS_JSON ?? '[]').filter(p => p.role === 'researcher');
  if (identities.length !== 1 || typeof identities[0].token !== 'string' || !identities[0].token) throw Error('Configure exactly one researcher credential');
  try {
    const response = await transport(new URL('/v1/lessons', origin), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Authorization: 'Bearer ' + identities[0].token, 'Content-Type': 'application/json', 'Idempotency-Key': 'vault-lesson-' + digest(body) }, body: JSON.stringify(body) });
    if (!response.ok) throw Error('rejected');
    const receipt = await response.json();
    if (!uuid.test(receipt.id ?? '')) throw Error('invalid receipt');
    return { lessonId: receipt.id, reviewRequired: true, qualificationChanged: false, snapshotSha256: snapshot.snapshotSha256 };
  } catch { throw Error('Lesson not acknowledged. Confirm the bot is active and evidence independently verified; retry the same snapshot after checking backend status.'); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [mode, first, second, ...extra] = process.argv.slice(2);
    if (extra.length || !first || !['prepare', 'submit'].includes(mode) || (mode === 'prepare' ? !second : second !== undefined)) throw Error('Usage: prepare VAULT NOTE_RELATIVE_TO_NOTES | submit SNAPSHOT_JSON');
    const result = mode === 'prepare' ? await prepareLesson(first, second, fileURLToPath(new URL('../.local/obsidian-proposals', import.meta.url)))
      : await submitLesson(JSON.parse(await bounded(first)));
    console.log(JSON.stringify(result, null, 2));
  } catch { console.error('Obsidian lesson operation failed. Check the template, paths, prepared snapshot and backend review requirements.'); process.exitCode = 1; }
}
