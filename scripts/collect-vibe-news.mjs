import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readBoundedJson } from './import-vibe-news.mjs';
import { convertNews } from '../integrations/vibe-trading/news-adapter.mjs';
import { collectNews, validateCollector } from '../integrations/vibe-trading/news-client.mjs';

export async function saveCollection(config, query, policy, destination, options) {
  validateCollector(config, query);
  // Validate mappings before contacting upstream; no approval or source creation occurs here.
  convertNews({ ok: true, source: 'yahoo', market: 'us', data: { articles: [] } }, policy);
  const directory = resolve(destination);
  await mkdir(directory); // Exclusive reservation: an existing directory is never overwritten.
  const collected = await collectNews(config, query, options);
  // Save the raw result first, so conversion failures do not discard the fetched evidence.
  await writeFile(join(directory, 'news.json'), JSON.stringify(collected.result, null, 2), { flag: 'wx' });
  await writeFile(join(directory, 'collection.json'), JSON.stringify(collected.transport, null, 2), { flag: 'wx' });
  const prepared = convertNews(collected.result, policy);
  await writeFile(join(directory, 'prepared.json'), JSON.stringify(prepared, null, 2), { flag: 'wx' });
  await writeFile(join(directory, 'complete.json'), JSON.stringify({ cleanup: collected.cleanup,
    accepted: prepared.observations.length, rejected: prepared.rejected.length,
    rawHash: prepared.provenance.rawHash, submitted: false }), { flag: 'wx' });
  return { directory, accepted: prepared.observations.length, rejected: prepared.rejected.length,
    cleanup: collected.cleanup, submitted: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 6) throw new Error('Usage: node scripts/collect-vibe-news.mjs collector.json query.json sources.json NEW_OUTPUT_DIRECTORY');
    const [config, query, policy] = await Promise.all(process.argv.slice(2, 5).map(path => readBoundedJson(path, 65536)));
    console.log(JSON.stringify(await saveCollection(config, query, policy, process.argv[5])));
  } catch { console.error('Collection failed. Check configuration and output directory; partial artifacts are retained. No evidence was submitted.'); process.exitCode = 1; }
}
