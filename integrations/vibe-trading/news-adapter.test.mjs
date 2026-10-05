import test from 'node:test';
import assert from 'node:assert/strict';
import { convertNews } from './news-adapter.mjs';

const now = Date.parse('2026-10-06T12:00:00Z');
const policy = { sources: [{ origin: 'https://publisher.example', sourceId: 'publisher' }] };
const article = { title: 'Example earnings', url: 'https://publisher.example/news/1',
  published: '2026-10-05 10:00:00', snippet: 'A synthetic earnings headline for adapter development.' };
const result = (articles = [article]) => ({ ok: true, source: 'yahoo', market: 'us', data: { articles } });

test('maps Yahoo UTC snippets into the existing importer contract', () => {
  const value = convertNews(result(), policy, now);
  assert.equal(value.observations.length, 1);
  assert.equal(value.observations[0].publishedAt, '2026-10-05T10:00:00.000Z');
  assert.equal(value.observations[0].sourceId, 'publisher');
  assert.match(value.observations[0].content, /^News snippet \(not the full article\):/);
  assert.equal(value.reviewRequired, true);
  assert.match(value.provenance.rawHash, /^[a-f0-9]{64}$/);
  assert.equal(value.provenance.rawHash, convertNews(result(), policy, now).provenance.rawHash);
});

test('rejects unapproved origins, credentials, missing snippets and invalid dates', () => {
  const values = [
    { url: 'https://publisher.example.attacker.test/news' },
    { url: 'https://user:secret@publisher.example/news' },
    { url: 'http://publisher.example/news' },
    { snippet: '' }, { published: '2026-02-30 10:00:00' },
    { published: '2027-01-01 10:00:00' }, { published: null },
  ].map(change => ({ ...article, ...change }));
  const value = convertNews(result(values), policy, now);
  assert.equal(value.observations.length, 0);
  assert.equal(value.rejected.length, values.length);
  assert.ok(!JSON.stringify(value.rejected).includes('secret'));
});

test('never guesses the timezone of Eastmoney dates', () => {
  const input = { ...result(), source: 'eastmoney', market: 'a_share' };
  assert.equal(convertNews(input, policy, now).observations.length, 0);
  input.data.articles = [{ ...article, published: '2026-10-05T02:00:00Z' }];
  assert.equal(convertNews(input, policy, now).observations.length, 1);
});

test('reports every duplicate and over-capacity record instead of silently dropping it', () => {
  const rows = Array.from({ length: 26 }, (_, i) => ({ ...article, url: article.url + '/' + i }));
  const value = convertNews(result([...rows, rows[0]]), policy, now);
  assert.equal(value.observations.length, 25);
  assert.deepEqual(value.rejected.map(row => row.reason), ['Import batch limit reached', 'Duplicate snapshot in result']);
});

test('fails closed for upstream failures, unknown providers and ambiguous mapping', () => {
  assert.throws(() => convertNews({ ok: false, error: 'upstream failure' }, policy, now));
  assert.throws(() => convertNews({ ...result(), source: 'other' }, policy, now));
  assert.throws(() => convertNews(result(), { sources: [...policy.sources, ...policy.sources] }, now));
  assert.throws(() => convertNews(result(Array(51).fill(article)), policy, now));
});
