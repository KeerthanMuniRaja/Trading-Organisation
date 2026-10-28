import { readdir, readFile, writeFile, mkdir, lstat } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
const hash = text => createHash('sha256').update(text).digest('hex');
async function read(path) { try { return await readFile(path, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
async function safe(root, target) {
  const rel = relative(root, target);
  if (rel.startsWith('..') || resolve(root, rel) !== target) throw Error('Path outside allowed root');
  let path = root;
  for (const part of ['', ...rel.split(/[\\/]/).filter(Boolean)]) {
    path = part ? join(path, part) : path;
    try { if ((await lstat(path)).isSymbolicLink()) throw Error('Symlink paths are not supported'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}
export async function syncVault(project, vault) {
  project = resolve(project); vault = resolve(vault);
  await safe(vault, join(vault, '.obsidian'));
  if (!(await lstat(join(vault, '.obsidian'))).isDirectory()) throw Error('Select an existing Obsidian vault');
  const base = join(vault, 'Trading-Organisation');
  await safe(vault, base);
  const manifestPath = join(base, '.sync-manifest.json');
  await safe(vault, manifestPath);
  const old = JSON.parse(await read(manifestPath) ?? '{"files":{}}');
  const files = {}, planned = new Map(), conflicts = [];
  async function include(rel) {
    const src = join(project, rel); await safe(project, src);
    const stat = await lstat(src);
    if (!stat.isFile() || stat.size > 1_000_000) throw Error('Invalid documentation file');
    planned.set('Library/' + rel.replaceAll('\\', '/'), await readFile(src, 'utf8'));
  }
  async function walk(rel) {
    await safe(project, join(project, rel));
    for (const e of await readdir(join(project, rel), { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
      if (e.isDirectory()) await walk(join(rel, e.name));
      else if (e.isFile() && e.name.endsWith('.md')) await include(join(rel, e.name));
    }
  }
  await walk('docs');
  for (const name of ['README.md', 'KT.md', 'RESUME-PROMPT.md']) if (await read(join(project, name)) !== null) await include(name);
  for (const entry of await readdir(join(project, 'integrations'), { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const rel = join('integrations', entry.name, 'README.md');
    await safe(project, join(project, rel));
    if (await read(join(project, rel)) !== null) await include(rel);
  }
  const replayIndex = [];
  const runs = join(project, '.local', 'market-replay');
  await safe(project, runs);
  let entries = []; try { entries = await readdir(runs, { withFileTypes: true }); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d{8}T\d{6,12}Z$/.test(entry.name)) continue;
    const source = join(runs, entry.name, 'report.json'); await safe(project, source);
    const raw = await read(source); if (!raw || raw.length > 5_000_000) continue;
    let r; try { r = JSON.parse(raw); } catch { continue; }
    if (r.mode !== 'historical-replay' || ![r.initialPaise, r.realisedNetPaise, r.unrealisedNetPaise, r.bars].every(Number.isSafeInteger)) continue;
    const title = 'Replay ' + entry.name;
    planned.set('Research/' + title + '.md', `---\ntype: replay-summary\nstatus: historical-unverified-summary\ntags: [trading-organisation, research]\n---\n# ${title}\n\n[[Trading-Organisation/Home|Organisation home]] · [[Trading-Organisation/Library/docs/historical-replay|Replay method]]\n\n- Bars: ${r.bars}\n- Starting simulated capital: ₹${(r.initialPaise / 100).toFixed(2)}\n- Realised net: ₹${(r.realisedNetPaise / 100).toFixed(2)}\n- Unrealised net: ₹${(r.unrealisedNetPaise / 100).toFixed(2)}\n\nSelected figures from a local saved report. This note is not evidence approval or proof of learning. The source report and raw data remain in the project; they are not copied into the vault.\n`);
    replayIndex.push(`- [[Trading-Organisation/Research/${title}]]`);
  }
  planned.set('Home.md', `---\ntype: organisation-home\ntags: [trading-organisation]\n---\n# Trading organisation\n\n## Vision and organisation\n\n- [[Trading-Organisation/Library/docs/knowledge-base/01-vision-and-principles|Our vision]]\n- [[Trading-Organisation/Library/docs/knowledge-base/11-research-development-and-bot-lifecycle|Bot birth, development and retirement]]\n- [[Trading-Organisation/Library/docs/bot-knowledge|Knowledge graph and transfer]]\n\n## Operating now\n\n- [[Trading-Organisation/Library/docs/live-testing|Daily runbook (live paper testing)]]\n- [[Trading-Organisation/Library/docs/audit-2026-10-14|Honest status: the audit of 14 October]]\n- [[Trading-Organisation/Library/KT|Knowledge transfer: start here]]\n- [[Trading-Organisation/Library/docs/trade-signals|How trades are proposed, reviewed and scored]]\n- [[Trading-Organisation/Library/docs/bot-control|Suspend, resume, budget, retire]]\n- [[Trading-Organisation/Library/docs/paper-performance|Paper P&L and the basket benchmark]]\n\n## Development and learning\n\n- [[Trading-Organisation/Library/docs/documentation-index|All documentation]]\n- [[Trading-Organisation/Library/docs/remaining-work-assessment|The plan (requirement definitions)]]\n- [[Trading-Organisation/Library/docs/academy-skills|Academy]]\n- [[Trading-Organisation/Library/docs/practice-benchmark|Model evaluation]]\n- [[Trading-Organisation/Library/docs/knowledge-base/12-wallet-and-treasury|Wallet rules]]\n- [[Trading-Organisation/Notes/Start here|Your own notes]]\n\n## Historical research\n\n${replayIndex.sort().join('\n') || 'No replay reports available.'}\n\n## Authority\n\nThis is a documentation and selected-research mirror, not a live backend dashboard. Editing a note cannot verify evidence, train weights, promote bots or change wallet permissions. Use Notes for ideas; Library and Research are generated. Syncs preserve edited generated files and report conflicts. No cloud sync or community plugins are configured.\n`);
  await safe(vault, join(base, 'Notes', 'Start here.md'));
  await mkdir(join(base, 'Notes'), { recursive: true });
  if (await read(join(base, 'Notes', 'Start here.md')) === null)
    await writeFile(join(base, 'Notes', 'Start here.md'), '# Your organisation notes\n\n[[Trading-Organisation/Home]]\n\nWrite questions, hypotheses and decisions here. Link notes with `[[Note name]]`. Notes are proposals, not approved bot instructions. This folder is never overwritten by the exporter.\n', { flag: 'wx' });
  for (const [rel, content] of planned) {
    const target = join(base, rel); await safe(vault, target);
    const current = await read(target);
    if (current !== null && current !== content && hash(current) !== old.files?.[rel]) {
      conflicts.push(rel); if (old.files?.[rel]) files[rel] = old.files[rel]; continue;
    }
    if (current !== content) { await mkdir(resolve(target, '..'), { recursive: true }); await writeFile(target, content); }
    files[rel] = hash(content);
  }
  // No deletion: disappeared source documents remain historical until explicitly removed.
  await writeFile(manifestPath, JSON.stringify({ version: 1, files: { ...old.files, ...files } }, null, 2));
  return { vault, notes: planned.size, conflicts, direction: 'project-to-vault', backendModified: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw Error('Usage: npm run knowledge:obsidian -- ABSOLUTE_VAULT_PATH');
    console.log(JSON.stringify(await syncVault(fileURLToPath(new URL('../', import.meta.url)), process.argv[2]), null, 2));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
