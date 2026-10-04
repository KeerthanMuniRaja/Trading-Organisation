import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleNews, readBoundedJson } from './import-vibe-news.mjs';

const now = Date.parse('2026-10-06T12:00:00Z');
const article = { title: 'Fixture', url: 'https://publisher.example/story',
  published: '2026-10-05 10:00:00', snippet: 'Synthetic test news, not investment research.' };
const result = { ok: true, source: 'yahoo', market: 'us', data: { articles: [article] } };
const policy = { sources: [{ origin: 'https://publisher.example', sourceId: 'fixture' }] };
const env = { API_URL: 'http://127.0.0.1:3000', PRINCIPALS_JSON: JSON.stringify([{role: 'researcher', token: 'test-only'}]) };

test('preparation needs no credentials and never sends a request', async () => {
  const value = await handleNews('prepare', result, policy, {}, () => assert.fail('unexpected request'), now);
  assert.equal(value.observations.length, 1);
});

test('submission uses the existing evidence endpoint and retry key', async () => {
  const calls = [];
  const transport = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ id: 'fixture-id', status: 'unverified' }) };
  };
  const value = await handleNews('submit', result, policy, env, transport, now);
  await handleNews('submit', result, policy, env, transport, now);
  assert.equal(value.reviewRequired, true);
  assert.equal(value.results[0].status, 'unverified');
  assert.equal(calls[0].url.pathname, '/v1/sources/observations');
  assert.equal(calls[0].options.headers['Idempotency-Key'], calls[1].options.headers['Idempotency-Key']);
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(JSON.parse(calls[0].options.body).sourceId, 'fixture');
});

test('a single rejected row prevents the entire submission', async () => {
  let calls = 0;
  const mixed = { ...result, data: { articles: [article, { ...article, published: null }] } };
  await assert.rejects(() => handleNews('submit', mixed, policy, env, () => { calls++; }, now), /No submission/);
  await assert.rejects(() => handleNews('submit', { ...result, data: { articles: [] } }, policy, env, () => { calls++; }, now));
  assert.equal(calls, 0);
});

test('file reader rejects oversized and malformed inputs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vibe-news-'));
  try {
    const path = join(directory, 'input.json');
    await writeFile(path, '{"ok":true}');
    assert.deepEqual(await readBoundedJson(path, 11), { ok: true });
    await assert.rejects(() => readBoundedJson(path, 10), /size limit/);
    await writeFile(path, '{bad');
    await assert.rejects(() => readBoundedJson(path, 100), /valid JSON/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
