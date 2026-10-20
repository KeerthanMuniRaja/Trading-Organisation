import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNewsCycle } from './run-vibe-cycle.mjs';
import { convertNews } from '../integrations/vibe-trading/news-adapter.mjs';

const config = { enabled: true, endpoint: 'http://127.0.0.1:8900/mcp' };
const query = { scope: 'stock', code: 'AAPL.US', limit: 5 };
const policy = { sources: [{ origin: 'https://publisher.example', sourceId: 'fixture' }] };
const env = { API_URL: 'http://127.0.0.1:3000', PRINCIPALS_JSON: JSON.stringify([{ role: 'researcher', token: 'test-only' }]) };
const article = { title: 'Fixture', snippet: 'Synthetic news for cycle verification.',
  published: '2026-01-01 10:00:00', url: 'https://publisher.example/1' };
const news = { ok: true, source: 'yahoo', market: 'us', data: { scope: 'stock', code: 'AAPL.US', articles: [article] } };
async function fixture(t, raw = news) {
  const root = await mkdtemp(join(tmpdir(), 'news-cycle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [], collected = [];
  const collect = async (config, query, policy, path) => {
    collected.push(path);
    await mkdir(path);
    await writeFile(join(path, 'news.json'), JSON.stringify(raw));
    await writeFile(join(path, 'complete.json'), JSON.stringify({ rawHash: convertNews(raw, policy).provenance.rawHash }));
  };
  const transport = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ id: 'evidence-' + calls.length, status: 'unverified' }) };
  };
  return { path: join(root, 'cycle'), calls, collected, options: { env, collect, transport } };
}

test('collects and submits once; completed cycles resume without network', async t => {
  const f = await fixture(t);
  const first = await runNewsCycle(config, query, policy, f.path, f.options);
  const second = await runNewsCycle(config, query, policy, f.path, f.options);
  assert.equal(first.state, 'awaiting-review');
  assert.equal(first.reviewRequired, true);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(f.collected.length, 1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url.pathname, '/v1/sources/observations');
  assert.ok(!(await readFile(join(f.path, 'manifest.json'), 'utf8')).includes('test-only'));
});

test('lost acknowledgement resumes the saved snapshot with identical retry keys', async t => {
  const f = await fixture(t);
  const real = f.options.transport;
  f.options.transport = async (...args) => { await real(...args); throw new Error('lost after acceptance'); };
  await assert.rejects(() => runNewsCycle(config, query, policy, f.path, f.options));
  f.options.transport = real;
  const value = await runNewsCycle(config, query, policy, f.path, f.options);
  assert.equal(value.state, 'awaiting-review');
  assert.equal(f.collected.length, 1);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].options.body, f.calls[1].options.body);
  assert.equal(f.calls[0].options.headers['Idempotency-Key'], f.calls[1].options.headers['Idempotency-Key']);
});

test('changed query, policy or backend identity cannot reuse a cycle', async t => {
  const f = await fixture(t);
  await runNewsCycle(config, query, policy, f.path, f.options);
  await assert.rejects(() => runNewsCycle(config, { ...query, code: 'MSFT.US' }, policy, f.path, f.options), /changed/);
  await assert.rejects(() => runNewsCycle(config, query, { sources: [] }, f.path, f.options), /changed/);
  await assert.rejects(() => runNewsCycle(config, query, policy, f.path, { ...f.options, env: { ...env, API_URL: 'http://127.0.0.1:3001' } }), /changed/);
  await assert.rejects(() => runNewsCycle(config, query, policy, f.path, { ...f.options, env: { ...env,
    PRINCIPALS_JSON: JSON.stringify([{ role: 'researcher', token: 'other-test-token' }]) } }), /changed/);
  assert.equal(f.calls.length, 1);
});

for (const [state, rows] of [['no-news', []], ['blocked', [{ ...article, published: null }]]])
  test(`${state} preserves diagnostics and never submits`, async t => {
    const f = await fixture(t, { ...news, data: { ...news.data, articles: rows } });
    assert.equal((await runNewsCycle(config, query, policy, f.path, f.options)).state, state);
    assert.equal(f.calls.length, 0);
  });

test('incomplete collection is not silently fetched again', async t => {
  const f = await fixture(t);
  f.options.collect = async (c, q, p, path) => { await mkdir(path); throw new Error('interrupted'); };
  await assert.rejects(() => runNewsCycle(config, query, policy, f.path, f.options));
  f.options.collect = () => assert.fail('must not refetch');
  await assert.rejects(() => runNewsCycle(config, query, policy, f.path, f.options), /Incomplete collection/);
  assert.equal(f.calls.length, 0);
});

test('changed raw snapshot cannot be submitted after a failed acknowledgement', async t => {
  const f = await fixture(t);
  f.options.transport = async () => { throw new Error('offline'); };
  await assert.rejects(() => runNewsCycle(config, query, policy, f.path, f.options));
  await writeFile(join(f.path, 'collection', 'news.json'), JSON.stringify({ ...news, data: { ...news.data, articles: [] } }));
  await assert.rejects(() => runNewsCycle(config, query, policy, f.path, f.options), /hash mismatch/);
});

test('a competing worker cannot enter a locked cycle', async t => {
  const f = await fixture(t);
  const actual = f.options.collect;
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  f.options.collect = async (...args) => { entered(); await barrier; return actual(...args); };
  const first = runNewsCycle(config, query, policy, f.path, f.options);
  await started;
  try { await assert.rejects(() => runNewsCycle(config, query, policy, f.path, f.options), /locked/); }
  finally { release(); await first; }
  assert.equal(f.calls.length, 1);
});
