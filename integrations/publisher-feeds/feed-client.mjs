import { parseSourceMappings } from '../../scripts/import-observations.mjs';
import { MAX_FEED_BYTES } from './feed-parser.mjs';

const FIELDS = ['enabled', 'feedUrl', 'kind', 'sources', 'maxItemsPerCycle', 'pollIntervalMinutes', 'timeoutMs'];
const FEED_TYPES = new Set(['application/rss+xml', 'application/atom+xml', 'application/xml', 'text/xml']);

/** Fixed operational codes; upstream bodies, headers and exception text are never echoed. */
export class FeedFetchError extends Error {
  constructor(code, retryAfterMs = null) { super(code); this.code = code; this.retryAfterMs = retryAfterMs; }
}

/**
 * One owner-configured feed URL. `allowLoopbackHttp` exists only for local test fixtures and is not
 * accepted from configuration files.
 */
export function validateFeedConfig(config, { allowLoopbackHttp = false } = {}) {
  if (!config || typeof config !== 'object' || config.enabled !== true || Object.keys(config).some(k => !FIELDS.includes(k)))
    throw new Error('Feed must be explicitly enabled with known configuration fields');
  if (typeof config.feedUrl !== 'string' || config.feedUrl.length > 2048) throw new Error('Invalid feed URL');
  const url = new URL(config.feedUrl);
  const loopback = allowLoopbackHttp && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !loopback) || url.username || url.password || url.hash)
    throw new Error('Feed URL must be HTTPS without credentials or fragment');
  const kind = config.kind ?? 'news';
  if (!['news', 'article', 'filing'].includes(kind)) throw new Error('Invalid observation kind');
  const sources = parseSourceMappings({ sources: config.sources });
  if (!sources.size) throw new Error('At least one publisher mapping is required');
  const integer = (value, fallback, min, max, label) => {
    const result = value ?? fallback;
    if (!Number.isInteger(result) || result < min || result > max) throw new Error('Invalid ' + label);
    return result;
  };
  return {
    feedUrl: url.href, kind,
    sources: [...sources].map(([origin, sourceId]) => ({ origin, sourceId })),
    maxItemsPerCycle: integer(config.maxItemsPerCycle, 20, 1, 50, 'item limit'),
    pollIntervalMinutes: integer(config.pollIntervalMinutes, 60, 15, 1440, 'poll interval'),
    timeoutMs: integer(config.timeoutMs, 15000, 1000, 30000, 'timeout'),
  };
}

function retryAfter(value, now) {
  if (!value) return null;
  if (/^\d{1,6}$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}
const validator = value => typeof value === 'string' && /^[\x21-\x7e][\x20-\x7e]{0,254}$/.test(value) ? value : null;

/** Single bounded GET. Redirects are refused so the only destinations are the configured feed and backend. */
export async function fetchFeed(feed, previous = {}, { transport = fetch, signal, now = Date.now() } = {}) {
  const deadline = AbortSignal.timeout(feed.timeoutMs);
  const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const headers = { Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8',
    'User-Agent': 'organisation-feed-collector/1.0' };
  if (validator(previous.etag)) headers['If-None-Match'] = previous.etag;
  if (validator(previous.lastModified)) headers['If-Modified-Since'] = previous.lastModified;
  let response;
  try {
    response = await transport(feed.feedUrl, { method: 'GET', redirect: 'manual', headers, signal: bounded });
  } catch { throw new FeedFetchError(bounded.aborted ? 'FEED_TIMEOUT' : 'FEED_UNREACHABLE'); }
  const discard = () => response.body?.cancel().catch(() => {});
  if (response.status === 304) { await discard(); return { status: 'not-modified', httpStatus: 304 }; }
  if (response.status >= 300 && response.status < 400 || response.type === 'opaqueredirect') {
    await discard(); throw new FeedFetchError('FEED_REDIRECT_REFUSED');
  }
  if (response.status === 429 || response.status === 503) {
    const wait = retryAfter(response.headers.get('retry-after'), now);
    await discard(); throw new FeedFetchError('FEED_RATE_LIMITED', wait);
  }
  if (response.status !== 200) { await discard(); throw new FeedFetchError('FEED_HTTP_ERROR'); }
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (!FEED_TYPES.has(type)) { await discard(); throw new FeedFetchError('FEED_CONTENT_TYPE'); }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_FEED_BYTES) { await discard(); throw new FeedFetchError('FEED_TOO_LARGE'); }
  const reader = response.body?.getReader();
  if (!reader) throw new FeedFetchError('FEED_HTTP_ERROR');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FEED_BYTES) throw new FeedFetchError('FEED_TOO_LARGE');
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof FeedFetchError) throw error;
    throw new FeedFetchError(bounded.aborted ? 'FEED_TIMEOUT' : 'FEED_UNREACHABLE');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return { status: 'fetched', httpStatus: 200, bytes: Buffer.concat(chunks.map(c => Buffer.from(c))),
    etag: validator(response.headers.get('etag')), lastModified: validator(response.headers.get('last-modified')) };
}
