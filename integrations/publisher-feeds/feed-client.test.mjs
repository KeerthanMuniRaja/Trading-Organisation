import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { FeedFetchError, fetchFeed, validateFeedConfig } from './feed-client.mjs';

const base = { enabled: true, feedUrl: 'https://feeds.publisher.example/markets.xml',
  sources: [{ origin: 'https://publisher.example', sourceId: 'publisher' }] };
const feed = validateFeedConfig(base);
const xml = '<rss version="2.0"><channel></channel></rss>';
const reply = (status, body = '', headers = {}) => async () => new Response(status === 304 ? null : body, { status, headers });
const code = async (promise, expected) => {
  await assert.rejects(promise, error => error instanceof FeedFetchError && error.code === expected);
};

test('configuration is explicit, HTTPS-only and bounded', () => {
  assert.deepEqual(feed, { feedUrl: base.feedUrl, kind: 'news', sources: base.sources, maxItemsPerCycle: 20,
    pollIntervalMinutes: 60, timeoutMs: 15000 });
  for (const bad of [{ ...base, enabled: false }, { ...base, extra: 1 }, { ...base, feedUrl: 'http://feeds.publisher.example/x' },
    { ...base, feedUrl: 'https://u:p@feeds.publisher.example/x' }, { ...base, feedUrl: 'https://feeds.publisher.example/x#f' },
    { ...base, sources: [] }, { ...base, pollIntervalMinutes: 1 }, { ...base, maxItemsPerCycle: 51 }, { ...base, kind: 'tweet' },
    { ...base, timeoutMs: 60000 }, { ...base, feedUrl: 'http://127.0.0.1:9/feed' }])
    assert.throws(() => validateFeedConfig(bad));
  // Loopback HTTP is an explicit test-harness option, never a configuration field.
  assert.equal(validateFeedConfig({ ...base, feedUrl: 'http://127.0.0.1:9/feed' }, { allowLoopbackHttp: true }).feedUrl, 'http://127.0.0.1:9/feed');
  assert.throws(() => validateFeedConfig({ ...base, feedUrl: 'http://192.168.1.2/feed' }, { allowLoopbackHttp: true }));
});

test('conditional requests send saved validators and accept 304', async () => {
  let seen;
  const result = await fetchFeed(feed, { etag: '"v1"', lastModified: 'Tue, 06 Oct 2026 09:00:00 GMT' }, {
    transport: async (url, options) => { seen = { url, options }; return new Response(null, { status: 304 }); } });
  assert.deepEqual(result, { status: 'not-modified', httpStatus: 304 });
  assert.equal(seen.options.redirect, 'manual');
  assert.equal(seen.options.headers['If-None-Match'], '"v1"');
  assert.equal(seen.options.headers['If-Modified-Since'], 'Tue, 06 Oct 2026 09:00:00 GMT');
  assert.ok(!('Authorization' in seen.options.headers));
  const fresh = await fetchFeed(feed, { etag: 'bad\nvalue' }, { transport: async (url, options) => {
    assert.ok(!('If-None-Match' in options.headers));
    return new Response(xml, { status: 200, headers: { 'content-type': 'application/rss+xml; charset=utf-8', etag: '"v2"' } });
  } });
  assert.equal(fresh.bytes.toString(), xml);
  assert.equal(fresh.etag, '"v2"');
});

test('redirects, errors, wrong types and oversized bodies fail closed with fixed codes', async () => {
  await code(fetchFeed(feed, {}, { transport: reply(301, '', { location: 'https://evil.example/' }) }), 'FEED_REDIRECT_REFUSED');
  await code(fetchFeed(feed, {}, { transport: reply(500, 'secret upstream detail') }), 'FEED_HTTP_ERROR');
  await code(fetchFeed(feed, {}, { transport: reply(200, '<html/>', { 'content-type': 'text/html' }) }), 'FEED_CONTENT_TYPE');
  await code(fetchFeed(feed, {}, { transport: reply(200, xml, { 'content-type': 'text/xml', 'content-length': '2000000' }) }), 'FEED_TOO_LARGE');
  await code(fetchFeed(feed, {}, { transport: reply(200, 'x'.repeat(1048577), { 'content-type': 'text/xml' }) }), 'FEED_TOO_LARGE');
  await code(fetchFeed(feed, {}, { transport: async () => { throw new Error('ECONNREFUSED internal-host'); } }), 'FEED_UNREACHABLE');
  const now = Date.parse('2026-10-06T00:00:00Z');
  await assert.rejects(fetchFeed(feed, {}, { now, transport: reply(429, '', { 'retry-after': '120' }) }),
    error => error.code === 'FEED_RATE_LIMITED' && error.retryAfterMs === 120000);
  await assert.rejects(fetchFeed(feed, {}, { now, transport: reply(503, '', { 'retry-after': 'Tue, 06 Oct 2026 01:00:00 GMT' }) }),
    error => error.code === 'FEED_RATE_LIMITED' && error.retryAfterMs === 3600000);
});

test('real loopback HTTP: redirects are not followed and slow publishers time out', async t => {
  const hits = [];
  const server = createServer((request, response) => {
    hits.push(request.url);
    if (request.url === '/moved') { response.writeHead(302, { location: '/target' }); response.end(); return; }
    if (request.url === '/slow') { setTimeout(() => response.end(), 3000).unref(); return; }
    response.writeHead(200, { 'content-type': 'application/atom+xml', 'last-modified': 'Tue, 06 Oct 2026 09:00:00 GMT' });
    response.end('<feed xmlns="http://www.w3.org/2005/Atom"></feed>');
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => { server.closeAllConnections(); server.close(done); }));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const local = path => validateFeedConfig({ ...base, feedUrl: origin + path, timeoutMs: 1000 }, { allowLoopbackHttp: true });
  await code(fetchFeed(local('/moved')), 'FEED_REDIRECT_REFUSED');
  assert.ok(!hits.includes('/target'));
  await code(fetchFeed(local('/slow')), 'FEED_TIMEOUT');
  const ok = await fetchFeed(local('/feed'));
  assert.equal(ok.lastModified, 'Tue, 06 Oct 2026 09:00:00 GMT');
  assert.match(ok.bytes.toString(), /^<feed/);
});
