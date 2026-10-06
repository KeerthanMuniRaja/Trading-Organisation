import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { saveCollection } from './collect-vibe-news.mjs';
import { handleNews, readBoundedJson } from './import-vibe-news.mjs';
import { backendBinding, exists, lockDirectory, save, stableHash as hash } from './cycle-state.mjs';
import { validateCollector } from '../integrations/vibe-trading/news-client.mjs';
import { convertNews } from '../integrations/vibe-trading/news-adapter.mjs';

/** Finite collect -> persist -> submit cycle. Backend independent review remains required. */
export async function runNewsCycle(config, query, policy, destination, {
  env = process.env, transport = fetch, collect = saveCollection,
} = {}) {
  const validated = validateCollector(config, query);
  convertNews({ ok: true, source: 'yahoo', market: 'us', data: { articles: [] } }, policy);
  const binding = backendBinding(env);
  const fingerprint = hash({ version: 1, config: validated, policy, backend: binding });
  const { directory, release } = await lockDirectory(destination, 'cycle.lock', 'Cycle');
  try {
    const manifestPath = join(directory, 'manifest.json');
    if (await exists(manifestPath)) {
      const manifest = await readBoundedJson(manifestPath, 4096);
      if (manifest.version !== 1 || manifest.fingerprint !== fingerprint) throw new Error('Cycle inputs or backend identity changed');
    } else {
      // Refuse to adopt orphaned artifacts under a new configuration.
      if (await exists(join(directory, 'collection')) || await exists(join(directory, 'outcome.json')))
        throw new Error('Orphaned cycle artifacts require manual inspection');
      await save(manifestPath, { version: 1, fingerprint, createdAt: new Date().toISOString() });
    }
    const outcomePath = join(directory, 'outcome.json');
    if (await exists(outcomePath)) return { ...await readBoundedJson(outcomePath, 65536), reused: true };
    const collectionPath = join(directory, 'collection');
    if (!await exists(collectionPath)) await collect(config, query, policy, collectionPath);
    if (!await exists(join(collectionPath, 'complete.json')))
      throw new Error('Incomplete collection retained; inspect it before recovery. No automatic refetch.');
    const complete = await readBoundedJson(join(collectionPath, 'complete.json'), 4096);
    const raw = await readBoundedJson(join(collectionPath, 'news.json'), 262144);
    const prepared = convertNews(raw, policy);
    if (complete.rawHash !== prepared.provenance.rawHash) throw new Error('Saved collection hash mismatch');
    let outcome;
    if (prepared.rejected.length) outcome = { state: 'blocked', submitted: 0, rejected: prepared.rejected,
      reason: 'Invalid observations require inspection; no rows submitted' };
    else if (!prepared.observations.length) outcome = { state: 'no-news', submitted: 0 };
    else {
      // Same saved rows, credential and backend yield the importer's same idempotency keys.
      const result = await handleNews('submit', raw, policy, env, transport);
      outcome = { state: 'awaiting-review', ...result };
    }
    const receipt = { ...outcome, fingerprint, rawHash: prepared.provenance.rawHash,
      finishedAt: new Date().toISOString(), reviewRequired: true };
    await save(outcomePath, receipt);
    return { ...receipt, reused: false };
  } finally { await release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 6) throw new Error('Invalid arguments');
    const [config, query, policy] = await Promise.all(process.argv.slice(2, 5).map(path => readBoundedJson(path, 65536)));
    console.log(JSON.stringify(await runNewsCycle(config, query, policy, process.argv[5])));
  } catch {
    console.error('News cycle stopped. Inspect saved artifacts and any cycle lock. Retry with unchanged inputs after confirming no worker is active; submissions may need acknowledgement recovery.');
    process.exitCode = 1;
  }
}
