import { pathToFileURL } from 'node:url';
import { convertNews } from '../integrations/vibe-trading/news-adapter.mjs';
import { importBatch } from './import-observations.mjs';
import { readBoundedJson } from './cycle-state.mjs';

export { readBoundedJson };

export async function handleNews(mode, result, policy, env = process.env, transport = fetch, now = Date.now()) {
  if (!['prepare', 'submit'].includes(mode)) throw new Error('Mode must be prepare or submit');
  const prepared = convertNews(result, policy, now);
  if (mode === 'prepare') return prepared;
  // Reject partial imports before sending anything. The operator can inspect prepare's diagnostics.
  if (prepared.rejected.length || !prepared.observations.length)
    throw new Error('No submission: result contains rejected rows or no observations. Use prepare to inspect it.');
  const imported = await importBatch(prepared.observations, env, transport);
  return { ...imported, provenance: prepared.provenance };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 5) throw new Error('Usage: node scripts/import-vibe-news.mjs prepare|submit news.json sources.json');
    const [result, policy] = await Promise.all([
      readBoundedJson(process.argv[3], 262144), readBoundedJson(process.argv[4], 65536),
    ]);
    console.log(JSON.stringify(await handleNews(process.argv[2], result, policy), null, 2));
  } catch (error) {
    // Filesystem errors can expose local paths; only known validation messages are printed.
    console.error(error.code ? 'Could not read input files' : error.message);
    process.exitCode = 1;
  }
}
