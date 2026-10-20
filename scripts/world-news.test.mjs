import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cluster, coverage, enable, loadCatalogue, probe, stories } from './world-news.mjs';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const source = (id, country, extra = {}) => ({ id, name: `Wire ${id}`, country, tier: 2, topics: ['markets'], feedUrl: `https://${id}.example/feed.xml`,
  origin: `https://${id}.example`, sourceId: `news-${id}`, backup: null, checked: '2026-10-20', ...extra });
const rss = (origin, items) => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>T</title>${items.map((t, n) =>
  `<item><title>${t}</title><link>${origin}/story/${n}</link><description>Summary of ${t}</description><pubDate>Tue, 20 Oct 2026 0${n}:00:00 GMT</pubDate></item>`).join('')}</channel></rss>`;
const feedResponse = (body, type = 'application/rss+xml') => new Response(body, { status: 200, headers: { 'content-type': type } });
const temp = () => mkdtemp(join(tmpdir(), 'world-'));

test('the catalogue is valid: official sources and publishers across countries, each backup listed', async () => {
  const sources = await loadCatalogue();
  assert.ok(new Set(sources.map(s => s.country)).size >= 5);
  assert.ok(sources.some(s => s.tier === 1 && s.country === 'US') && sources.some(s => s.country === 'CN'));
  assert.ok(sources.every(s => s.feedUrl.startsWith('https://')));
  const dir = await temp();
  try {
    await writeFile(join(dir, 'bad.json'), JSON.stringify({ sources: [source('a', 'IN', { backup: 'missing' })] }));
    await assert.rejects(loadCatalogue(join(dir, 'bad.json')), /Invalid catalogue entry a/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a probe reads the feed with the strict reader and stores nothing', async () => {
  const s = source('wire', 'US');
  const good = await probe(s, { transport: async () => feedResponse(rss(s.origin, ['Fed holds', 'Markets rally'])), now: NOW });
  assert.deepEqual([good.ok, good.accepted, good.newest], [true, 2, '2026-10-20T01:00:00.000Z']);
  const html = await probe(s, { transport: async () => feedResponse('<html></html>', 'text/html'), now: NOW });
  assert.deepEqual([html.ok, html.problem], [false, 'FEED_CONTENT_TYPE']);
  const foreign = await probe(s, { transport: async () => feedResponse(rss('https://other.example', ['Elsewhere'])), now: NOW });
  assert.equal(foreign.ok, false); // every item links to an origin the source does not own
  assert.equal(foreign.reasons['Article origin has no source mapping'], 1);
});

test('enable: only a source whose probe passes is registered, approved and configured for the cycle', async () => {
  const root = await temp();
  try {
    const catalogue = [source('good', 'US'), source('broken', 'CN')];
    const transport = async url => url.includes('good') ? feedResponse(rss('https://good.example', ['Story'])) : feedResponse('x', 'text/html');
    const posted = [];
    const fetchImpl = async (url, init) => { posted.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
      return posted.length > 1 ? new Response('Source already exists', { status: 409 }) : new Response('{}', { status: 201 }); };
    const env = { PRINCIPALS_JSON: JSON.stringify([{ id: 'o', role: 'owner', token: 'owner-token' }]), API_URL: 'http://127.0.0.1:9' };
    const out = await enable(['good', 'broken', 'nope'], { env, root, catalogue, transport, fetchImpl, now: NOW });
    assert.deepEqual(out.map(r => r.state), ['enabled', 'not enabled', 'unknown id']);
    assert.deepEqual(posted[0].body, { id: 'news-good', name: 'Wire good', url: 'https://good.example', approved: true });
    assert.equal(posted[0].auth, 'Bearer owner-token');
    const config = JSON.parse(await readFile(join(root, '.local', 'feed-good.json'), 'utf8'));
    assert.deepEqual([config.enabled, config.sources[0].sourceId], [true, 'news-good']);
    assert.ok(!existsSync(join(root, '.local', 'feed-broken.json')));
    // enabling again is harmless: the backend already has the source
    assert.equal((await enable(['good'], { env, root, catalogue, transport, fetchImpl, now: NOW }))[0].state, 'enabled');
    await assert.rejects(enable(['good'], { env: {}, root, catalogue, transport, fetchImpl }), /exactly one owner/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('coverage: working, failing and stale feeds by country; a broken feed names its backup', async () => {
  const root = await temp();
  try {
    const catalogue = [source('in-a', 'IN'), source('cn-a', 'CN', { backup: 'cn-b' }), source('cn-b', 'CN'), source('us-a', 'US')];
    await mkdir(join(root, '.local', 'feeds'), { recursive: true });
    const on = async (id, checkpoint) => {
      await writeFile(join(root, '.local', `feed-${id}.json`), JSON.stringify({ enabled: true }));
      if (checkpoint) { await mkdir(join(root, '.local', 'feeds', id), { recursive: true });
        await writeFile(join(root, '.local', 'feeds', id, 'checkpoint.json'), JSON.stringify(checkpoint)); }
    };
    await on('in-a', { consecutiveFailures: 0, lastSuccessAt: '2026-10-20T10:00:00Z' });
    await on('cn-a', { consecutiveFailures: 2, lastFailureCode: 'FEED_HTTP_ERROR', lastSuccessAt: '2026-10-18T10:00:00Z' });
    await on('us-a', { consecutiveFailures: 0, lastSuccessAt: '2026-10-10T10:00:00Z' });
    const c = await coverage({ root, catalogue, now: NOW });
    assert.deepEqual(c.sources.map(r => r.state), ['working', 'failing', 'off', 'stale']);
    assert.deepEqual(c.countriesCovered, ['IN']);
    assert.match(c.advice[0], /Wire cn-a is failing \(FEED_HTTP_ERROR ×2\); enable its backup: npm run world -- enable cn-b --yes/);
    assert.match(c.advice[1], /Wire us-a is stale \(last read 2026-10-10\); no backup listed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

const links = [{ driver: 'us-fed-rates', region: 'US', keywords: ['federal reserve'], symbols: ['HDFCBANK.NS', 'INFY.NS'], basis: 'b' },
  { driver: 'crude-oil', keywords: ['brent'], symbols: ['RELIANCE.NS'], basis: 'b' }];
const item = (sourceId, title, hour, extra = {}) => ({ sourceId, title, url: `https://${sourceId.slice(5)}.example/${encodeURIComponent(title)}`,
  publishedAt: `2026-10-20T0${hour}:00:00.000Z`, content: 'Feed summary (not the full article):\n' + title, kind: 'news', ...extra });

test('stories: one story across countries and publishers, linked to the shares directly and through drivers', () => {
  const catalogue = [source('us', 'US'), source('cn', 'CN'), source('in', 'IN')];
  const out = cluster([
    item('news-us', 'Federal Reserve holds interest rates steady as inflation cools', 1),
    item('news-cn', 'Federal Reserve holds rates steady as inflation cools, markets wait', 2),
    item('news-in', 'Infosys wins a large deal in Europe', 3),
    item('news-in', 'A cricket final draws a record crowd', 4),
  ], { catalogue, links });
  assert.equal(out.length, 3);
  const fed = out.find(s => s.title.startsWith('Federal Reserve holds interest'));
  assert.deepEqual([fed.items, fed.publishers, fed.countries, fed.crossBorder], [2, 2, ['CN', 'US'], true]);
  assert.deepEqual(fed.drivers, [{ driver: 'us-fed-rates', region: 'US', shares: ['HDFCBANK', 'INFY'] }]);
  const infy = out.find(s => s.title.startsWith('Infosys'));
  assert.deepEqual([infy.directShares, infy.crossBorder], [['INFY'], false]);
  assert.equal(out.at(-1).title, 'A cricket final draws a record crowd'); // reaches no share: ranked last
  // the same link in two feeds is one item (syndication counts once)
  const dup = cluster([item('news-us', 'Brent jumps', 1), item('news-us', 'Brent jumps', 2)], { catalogue, links });
  assert.deepEqual([dup.length, dup[0].items, dup[0].drivers[0].shares], [1, 2, ['RELIANCE']]);
});

test('stories read the feed runs of the window and write the latest report', async () => {
  const root = await temp();
  try {
    const run = join(root, '.local', 'feeds', 'us', 'runs', 'r1');
    await mkdir(run, { recursive: true });
    await writeFile(join(run, 'selection.json'), JSON.stringify({ observations: [item('news-us', 'Federal Reserve cuts rates', 1),
      { ...item('news-us', 'Old story', 1), publishedAt: '2026-10-01T00:00:00.000Z' }] }));
    const r = await stories({ root, hours: 48, now: NOW, catalogue: [source('us', 'US')], links });
    assert.deepEqual([r.items, r.stories, r.reachingShares], [1, 1, 1]);
    const latest = JSON.parse(await readFile(join(root, '.local', 'world', 'latest.json'), 'utf8'));
    assert.equal(latest.top[0].drivers[0].driver, 'us-fed-rates');
    assert.ok(existsSync(join(root, '.local', 'world', 'stories-2026-10-20.json')));
    assert.match(latest.note, /Unverified press/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
