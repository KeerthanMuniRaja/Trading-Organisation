import { createHash } from 'node:crypto';
import { parseSourceMappings, validateBatch } from '../../scripts/import-observations.mjs';

// Offline boundary: accepts the decoded get_stock_news result, never executes tools.
export function convertNews(result, policy, now = Date.now()) {
  if (!Number.isFinite(now)) throw new Error('Invalid reference time');
  if (!result || result.ok !== true || !Array.isArray(result.data?.articles) ||
      result.data.articles.length > 50) throw new Error('Expected a successful bounded news result');
  const sources = parseSourceMappings(policy);
  const yahoo = result.source === 'yahoo' && ['us', 'hk'].includes(result.market);
  const eastmoney = result.source === 'eastmoney' && ['a_share', 'global'].includes(result.market);
  if (!yahoo && !eastmoney) throw new Error('Unsupported news provider/market combination');
  const observations = [], rejected = [], seen = new Set();
  const serialized = JSON.stringify(result);
  if (Buffer.byteLength(serialized) > 262144) throw new Error('News result exceeds 256 KiB');
  const rawHash = createHash('sha256').update(serialized).digest('hex');
  for (const [index, article] of result.data.articles.entries()) {
    try {
      if (!article || typeof article.url !== 'string') throw new Error('Missing article URL');
      const url = new URL(article.url);
      const sourceId = sources.get(url.origin);
      if (!sourceId) throw new Error('Article origin has no source mapping');
      if (typeof article.title !== 'string' || !article.title.trim() ||
          typeof article.snippet !== 'string' || !article.snippet.trim())
        throw new Error('Title and nonempty snippet required');
      let published = article.published;
      // The inspected Yahoo implementation serializes UTC without a zone suffix.
      // Eastmoney's unzoned dates are deliberately not assigned a guessed timezone.
      if (yahoo && typeof published === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(published))
        published = published.replace(' ', 'T') + 'Z';
      if (typeof published !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(published))
        throw new Error('An explicit UTC publication timestamp is required');
      const date = new Date(published);
      if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== published.slice(0, 19) || date.getTime() > now)
        throw new Error('Invalid or future publication time');
      const row = validateBatch([{ sourceId, url: article.url, title: article.title, kind: 'news',
        content: 'News snippet (not the full article):\n' + article.snippet,
        publishedAt: date.toISOString() }])[0];
      row.url = url.href;
      row.title = row.title.trim();
      const identity = JSON.stringify(row);
      if (seen.has(identity)) throw new Error('Duplicate snapshot in result');
      if (observations.length === 25) throw new Error('Import batch limit reached');
      seen.add(identity);
      observations.push(row);
    } catch (error) {
      // Do not echo upstream text or URLs into diagnostics.
      const allowed = new Set(['Missing article URL', 'Article origin has no source mapping',
        'Title and nonempty snippet required', 'An explicit UTC publication timestamp is required',
        'Invalid or future publication time', 'Duplicate snapshot in result', 'Import batch limit reached']);
      rejected.push({ index, reason: allowed.has(error.message) ? error.message : 'Invalid article fields' });
    }
  }
  return { observations, rejected, provenance: { adapter: 'vibe-stock-news-v1', rawHash,
    provider: result.source, market: result.market, scope: 'collector-submitted-snippets' }, reviewRequired: true };
}
