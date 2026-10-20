import { mkdir, writeFile, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const identifier = /^[A-Za-z0-9_-]{1,80}$/;
const text = value => String(value ?? '').replace(/[\r\n]/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_[\]#!|])/g, '\\$1').slice(0, 300);
export function renderOrganisation(bots, knowledge, prefix, window) {
  if (!Array.isArray(bots) || bots.length > 1000 || !Array.isArray(knowledge?.evidence) || knowledge.evidence.length > 200 ||
      !Array.isArray(knowledge?.lessons) || knowledge.lessons.length > 200) throw Error('Unsupported snapshot size');
  const groups = [['Bot', bots], ['Evidence', knowledge.evidence], ['Lesson', knowledge.lessons]];
  for (const [, rows] of groups) {
    if (rows.some(r => !r || !identifier.test(r.id)) || new Set(rows.map(r => r.id)).size !== rows.length) throw Error('Invalid or duplicate record IDs');
  }
  const botIds = new Set(bots.map(b => b.id)), evidenceIds = new Set(knowledge.evidence.map(e => e.id));
  const nodes = new Map();
  const link = (kind, id) => `[[${prefix}/${kind}-${id}]]`;
  const head = (kind, id) => `---\ntype: organisation-${kind.toLowerCase()}\nstatus: historical-snapshot\ntags: [nexus, organisation]\n---\n# ${kind} ${id}\n\n[[${prefix}/Index|Snapshot index]]\n\n`;
  for (const b of bots) {
    nodes.set(`Bot-${b.id}.md`, head('Bot', b.id) + `Name: ${text(b.name)}\n\nRecorded state: ${text(b.state)}\n\nDepartment: ${text(b.department)}\n\nSpecialty: ${text(b.specialty)}\n\n` +
      (botIds.has(b.mentor_id) ? `Mentor: ${link('Bot', b.mentor_id)}\n\n` : '') +
      'Reviewed lessons included in this response:\n\n' + (knowledge.lessons.filter(l => l.bot_id === b.id).map(l => '- ' + link('Lesson', l.id)).join('\n') || 'None returned.') + '\n');
  }
  for (const e of knowledge.evidence) nodes.set(`Evidence-${e.id}.md`, head('Evidence', e.id) +
    `Source ID: ${text(e.source_id)}\n\nKind: ${text(e.kind)}\n\nRecorded evidence status: ${text(e.status)}\n\nPublished at: ${text(e.published_at)}\n\nRaw source content is not exported. Backend approval at capture time is not proof that a claim is true.\n`);
  let omittedReferences = 0;
  for (const l of knowledge.lessons) {
    const bot = botIds.has(l.bot_id), evidence = evidenceIds.has(l.evidence_id);
    omittedReferences += Number(!bot) + Number(!evidence);
    nodes.set(`Lesson-${l.id}.md`, head('Lesson', l.id) +
      `Author bot: ${bot ? link('Bot', l.bot_id) : 'Not included in bounded response'}\n\nSupporting evidence: ${evidence ? link('Evidence', l.evidence_id) : 'Not included in bounded response'}\n\nReturned by the backend reviewed-knowledge endpoint. This note is a historical reference, not approval authority. Full lesson text stays in the backend.\n`);
  }
  nodes.set('Index.md', `---\ntype: organisation-snapshot\nstatus: historical-snapshot\ntags: [nexus, organisation]\n---\n# Organisation snapshot\n\n[[Nexus/Home]]\n\nCapture window: ${text(window.startedAt)} to ${text(window.finishedAt)}.\n\nSeparate GET requests; not a single transactional snapshot. Revocations or state changes after capture are not reflected here. Older snapshots remain historical.\n\nBots: ${bots.length}; reviewed lessons: ${knowledge.lessons.length}; evidence: ${knowledge.evidence.length}.\n\nThe knowledge endpoint returns at most 200 evidence and 200 lesson records. This view is not a complete organisation graph. References outside the returned records: ${omittedReferences}.\n\n## Bots\n\n${bots.map(b => '- ' + link('Bot', b.id)).join('\n') || 'None returned.'}\n\n## Reviewed lessons\n\n${knowledge.lessons.map(l => '- ' + link('Lesson', l.id)).join('\n') || 'None returned.'}\n`);
  return nodes;
}
export async function captureOrganisation(vault, env = process.env, transport = fetch) {
  const root = resolve(vault), parent = join(root, 'Nexus', 'Organisation');
  for (const path of [root, join(root, '.obsidian'), join(root, 'Nexus'), parent]) {
    try { const s = await lstat(path); if (s.isSymbolicLink() || !s.isDirectory()) throw Error('Use ordinary vault directories'); }
    catch (e) { if (e.code !== 'ENOENT' || path === root || path.endsWith('.obsidian')) throw e; }
  }
  const base = new URL(env.API_URL ?? 'http://127.0.0.1:3000');
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/' ||
      !(base.protocol === 'https:' || (base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))) throw Error('Invalid backend origin');
  const actors = JSON.parse(env.PRINCIPALS_JSON ?? '[]').filter(p => p.role === 'researcher');
  if (actors.length !== 1 || typeof actors[0].token !== 'string' || !actors[0].token) throw Error('Exactly one researcher credential required');
  async function get(route) {
    try {
      const response = await transport(new URL(route, base), { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Authorization: 'Bearer ' + actors[0].token } });
      if (!response.ok || !response.body) throw Error('request failed');
      let size = 0; const chunks = [];
      for await (const chunk of response.body) { size += chunk.length; if (size > 2_000_000) throw Error('response too large'); chunks.push(Buffer.from(chunk)); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { throw Error('Organisation snapshot request failed; no provider response or credentials were logged'); }
  }
  const startedAt = new Date().toISOString();
  const bots = await get('/v1/bots'), knowledge = await get('/v1/knowledge');
  const finishedAt = new Date().toISOString();
  const name = finishedAt.replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
  const nodes = renderOrganisation(bots, knowledge, `Nexus/Organisation/${name}`, { startedAt, finishedAt });
  await mkdir(parent, { recursive: true });
  const directory = join(parent, name); await mkdir(directory);
  for (const [file, content] of nodes) await writeFile(join(directory, file), content, { flag: 'wx' });
  await writeFile(join(directory, 'complete.json'), JSON.stringify({ startedAt, finishedAt, noteCount: nodes.size, backendModified: false }), { flag: 'wx' });
  return { index: join(directory, 'Index.md'), notes: nodes.size, backendModified: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw Error('Supply the vault folder');
    console.log(JSON.stringify(await captureOrganisation(process.argv[2]), null, 2));
  } catch { console.error('Organisation snapshot failed. Check the vault, backend and researcher configuration. A folder without complete.json is incomplete.'); process.exitCode = 1; }
}
