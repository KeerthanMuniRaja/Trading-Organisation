import test from 'node:test';
import assert from 'node:assert/strict';
import { FeedFormatError, htmlToText, parseFeedDate, parseXml, prepareFeed } from './feed-parser.mjs';

const feed = { feedUrl: 'https://feeds.publisher.example/markets.xml', kind: 'news',
  sources: [{ origin: 'https://publisher.example', sourceId: 'publisher' }] };
const fetchedAt = Date.parse('2026-10-06T12:00:00Z');
const bytes = text => Buffer.from(text, 'utf8');
const rss = items => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>Markets</title>${items}</channel></rss>`;
const item = ({ title = 'Fees rise', link = 'https://publisher.example/a', description = 'Brokerage fees increased.',
  date = 'Tue, 06 Oct 2026 09:00:00 +0530' } = {}) =>
  `<item><title>${title}</title><link>${link}</link><description>${description}</description><pubDate>${date}</pubDate></item>`;

test('RSS 2.0 entries become labelled, plain-text observations with explicit UTC times', () => {
  const html = '<![CDATA[<p>Costs <b>matter</b> &amp; slippage.</p><script>alert(1)</script><p>Second &#8212; para</p>]]>';
  // Relative links resolve against the feed URL, so its origin needs its own explicit mapping.
  const mapped = { ...feed, sources: [...feed.sources, { origin: 'https://feeds.publisher.example', sourceId: 'publisher-feeds' }] };
  const result = prepareFeed(bytes(rss(item({ description: html }) + item({ title: 'Rel', link: '/b#frag', date: '06 Oct 2026 03:00 GMT' }))), mapped, fetchedAt);
  assert.equal(result.format, 'rss-2.0');
  assert.deepEqual(result.rejected, []);
  assert.equal(result.observations.length, 2);
  const [first, second] = result.observations;
  assert.deepEqual(Object.keys(first), ['sourceId', 'url', 'title', 'kind', 'content', 'publishedAt']);
  assert.equal(first.sourceId, 'publisher');
  assert.equal(first.content, 'Feed summary (not the full article):\nCosts matter & slippage.\nSecond — para');
  assert.equal(first.publishedAt, '2026-10-06T03:30:00.000Z');
  assert.equal(second.url, 'https://feeds.publisher.example/b');
  assert.equal(second.sourceId, 'publisher-feeds');
  assert.equal(prepareFeed(bytes(rss(item({ link: '/b' }))), feed, fetchedAt).rejected[0].reason, 'Article origin has no source mapping');
  assert.equal(second.publishedAt, '2026-10-06T03:00:00.000Z');
  assert.equal(result.provenance.adapter, 'publisher-feed-v1');
  assert.equal(result.reviewRequired, true);
});

test('Atom entries use the alternate link, html summaries and ordered xhtml content', () => {
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><title>X</title>
  <entry><title type="html">Rates &lt;b&gt;hold&lt;/b&gt;</title><link rel="self" href="https://elsewhere.example/x"/>
    <link href="https://publisher.example/rates"/><summary type="html">&lt;p&gt;Central bank holds.&lt;/p&gt;</summary>
    <updated>2026-10-05T08:00:00Z</updated><published>2026-10-05T07:30:00+05:30</published></entry>
  <entry><title>Mixed</title><link rel="alternate" href="https://publisher.example/mixed"/>
    <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">Hello <b>world</b> again</div></content>
    <updated>2026-10-05T09:00:00Z</updated></entry></feed>`;
  const result = prepareFeed(bytes(atom), feed, fetchedAt);
  assert.equal(result.format, 'atom-1.0');
  assert.equal(result.observations[0].title, 'Rates hold');
  assert.equal(result.observations[0].url, 'https://publisher.example/rates');
  assert.equal(result.observations[0].publishedAt, '2026-10-05T02:00:00.000Z');
  assert.match(result.observations[0].content, /Central bank holds\.$/);
  assert.equal(result.observations[1].content, 'Feed summary (not the full article):\nHello world again');
});

test('DTDs, entity expansion and malformed XML are refused before extraction', () => {
  const bomb = '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]><rss><channel>&lol2;</channel></rss>';
  const external = '<!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><rss version="2.0"><channel>&xxe;</channel></rss>';
  for (const xml of [bomb, external, '<rss><channel>&nbsp;</channel></rss>', '<rss><channel></rss>', '<rss/><rss/>',
    '<?xml version="1.0" encoding="ISO-8859-1"?><rss/>', '<rss a="1" a="2"/>', '<rss>\u0001</rss>', 'text<rss/>',
    '<a>'.repeat(40) + '</a>'.repeat(40), '<rss><channel>&#0;</channel></rss>', '<feed></feed>x<y/>'])
    assert.throws(() => parseXml(xml), FeedFormatError);
  assert.throws(() => prepareFeed(bytes('<html><body/></html>'), feed, fetchedAt), /Unsupported feed format/);
  assert.throws(() => prepareFeed(Buffer.from([0x3c, 0xff, 0x3e]), feed, fetchedAt), /UTF-8/);
});

test('invalid entries are skipped with fixed reasons that never echo publisher text', () => {
  const entries = [
    item({ link: 'https://unmapped.example/x' }),
    item({ link: 'http://publisher.example/plain' }),
    item({ description: '   ' }),
    item({ date: '2026-10-06 09:00:00' }),
    item({ date: 'Tue, 06 Oct 2026 09:00:00 EST' }),
    item({ date: 'Wed, 07 Oct 2026 09:00:00 GMT' }),
    item({ link: '' }),
    item({ title: 'Valid' }), item({ title: 'Valid' }),
    item({ link: 'https://user:secret@publisher.example/x' }),
  ].join('');
  const result = prepareFeed(bytes(rss(entries)), feed, fetchedAt);
  assert.equal(result.observations.length, 1);
  assert.deepEqual(result.rejected.map(r => r.reason), [
    'Article origin has no source mapping', 'Article link must be HTTPS without credentials',
    'Title and nonempty summary required', 'An explicit-zone publication timestamp is required',
    'An explicit-zone publication timestamp is required', 'Publication time is after retrieval',
    'Missing or invalid article link', 'Duplicate entry in feed', 'Article link must be HTTPS without credentials']);
  assert.ok(!JSON.stringify(result.rejected).includes('secret'));
  assert.ok(!JSON.stringify(result.rejected).includes('unmapped'));
});

test('long text is bounded to backend limits and feeds over 100 entries are marked truncated', () => {
  const long = prepareFeed(bytes(rss(item({ title: 'T'.repeat(400), description: 'x'.repeat(9000) }))), feed, fetchedAt).observations[0];
  assert.equal(long.title.length, 300);
  assert.equal(long.content.length, 4000);
  assert.ok(long.content.endsWith('[Summary truncated by collector]'));
  const many = prepareFeed(bytes(rss(Array.from({ length: 105 }, (_, i) => item({ link: 'https://publisher.example/' + i })).join(''))), feed, fetchedAt);
  assert.equal(many.truncated, true);
  assert.equal(many.observations.length, 100);
});

test('dates require a real calendar day and an explicit zone', () => {
  assert.equal(parseFeedDate('Mon, 05 Oct 2026 23:30:00 -0100'), Date.parse('2026-10-06T00:30:00Z'));
  assert.equal(parseFeedDate('2026-10-05T10:00:00.123456+14:00'), Date.parse('2026-10-04T20:00:00Z'));
  for (const bad of ['31 Feb 2026 10:00:00 GMT', '2026-13-01T00:00:00Z', '2026-10-05T24:00:00Z', '2026-10-05T10:00:00',
    '05 Oct 2026 10:00:00 PST', '2026-10-05T10:00:00+15:00', null, ''])
    assert.equal(parseFeedDate(bad), null, String(bad));
  assert.equal(htmlToText('a&nbsp;&nbsp;b<br/>c &unknown; &#x41;'), 'a b\nc &unknown; A');
});
