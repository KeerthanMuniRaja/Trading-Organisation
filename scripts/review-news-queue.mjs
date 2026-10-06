import { pathToFileURL } from 'node:url';
import { readBoundedJson } from './import-vibe-news.mjs';

export async function fetchReviewQueue(query, env = process.env, transport = fetch) {
  if (!query || typeof query !== 'object' || Array.isArray(query) ||
      Object.keys(query).some(key => !['sourceId', 'after', 'limit', 'includeBlocked'].includes(key)))
    throw new Error('Invalid queue query');
  const base = new URL(env.API_URL ?? 'http://127.0.0.1:3000');
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/' ||
      !(base.protocol === 'https:' || (base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))))
    throw new Error('Invalid backend origin');
  const principals = JSON.parse(env.PRINCIPALS_JSON ?? '[]');
  if (!Array.isArray(principals)) throw new Error('Invalid principal configuration');
  const evaluators = principals.filter(p => p?.role === 'evaluator');
  if (evaluators.length !== 1 || typeof evaluators[0].token !== 'string' || !evaluators[0].token)
    throw new Error('Configure exactly one evaluator credential');
  const response = await transport(new URL('/v1/sources/observations/review-queue', base), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { Authorization: 'Bearer ' + evaluators[0].token, 'Content-Type': 'application/json' },
    body: JSON.stringify(query),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error('Review queue request failed'); }
  const chunks = []; let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > 300000) throw new Error('Review queue response exceeds capacity');
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (value?.scope !== 'pending-source-observations' || !Array.isArray(value.observations) || value.observations.length > 50 ||
      !(value.nextCursor === null || typeof value.nextCursor === 'string')) throw new Error('Invalid review queue response');
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length > 3) throw new Error('Invalid arguments');
    const query = process.argv[2] ? await readBoundedJson(process.argv[2], 4096) : {};
    console.log(JSON.stringify(await fetchReviewQueue(query), null, 2));
  } catch { console.error('Could not read the evidence review queue. Check evaluator configuration and query.'); process.exitCode = 1; }
}
