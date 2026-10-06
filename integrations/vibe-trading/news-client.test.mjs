import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectNews } from './news-client.mjs';
import { saveCollection } from '../../scripts/collect-vibe-news.mjs';

const query = { scope: 'stock', code: 'AAPL.US', limit: 5 };
const news = { ok: true, source: 'yahoo', market: 'us', data: { scope: 'stock', code: 'AAPL.US', articles: [
  { title: 'Fixture', snippet: 'Synthetic news for collector tests only.', url: 'https://publisher.example/story', published: '2026-01-01 10:00:00' },
] } };

async function peer(t, behavior = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    requests.push({ method: req.method, headers: req.headers, body });
    if (req.method === 'DELETE') { res.writeHead(behavior.cleanupStatus ?? 200).end(); return; }
    if (behavior.redirect) { res.writeHead(307, { location: '/unexpected' }).end(); return; }
    if (body.method === 'notifications/initialized') { res.writeHead(202).end(); return; }
    let result;
    if (body.method === 'initialize') {
      res.setHeader('Mcp-Session-Id', 'fixture-session');
      result = { protocolVersion: behavior.protocol ?? '2025-03-26', capabilities: { tools: {} },
        serverInfo: { name: 'Vibe-Trading', version: 'fixture' } };
    } else {
      if (behavior.hang) return;
      result = { content: [{ type: 'text', text: JSON.stringify(behavior.news ?? news) }], ...(behavior.isError ? { isError: true } : {}) };
    }
    const envelope = JSON.stringify({ jsonrpc: '2.0', id: behavior.wrongId ? 999 : body.id, result });
    if (behavior.oversize && body.method === 'tools/call') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(' '.repeat(300001)); return;
    }
    if (behavior.sse) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': keepalive\r\n\r\n');
      res.write('data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\r\n\r\n');
      // Leave the stream open: the client must stop on the matching response, not EOF.
      res.write('event: message\r\ndata: ' + envelope + '\r\n');
      setImmediate(() => res.write('\r\n'));
    } else res.writeHead(200, { 'Content-Type': 'application/json' }).end(envelope);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { config: { enabled: true, endpoint: `http://127.0.0.1:${server.address().port}/mcp`, timeoutMs: 2000 }, requests };
}

for (const sse of [false, true]) test(`one read-only call over ${sse ? 'SSE' : 'JSON'} with session cleanup`, async t => {
  const { config, requests } = await peer(t, { sse });
  const value = await collectNews(config, query);
  assert.deepEqual(value.result, news);
  assert.equal(value.cleanup, 'closed');
  assert.deepEqual(requests.map(r => r.body?.method ?? r.method), ['initialize', 'notifications/initialized', 'tools/call', 'DELETE']);
  assert.equal(requests[2].body.params.name, 'get_stock_news');
  assert.deepEqual(requests[2].body.params.arguments, query);
  assert.equal(requests[2].headers['mcp-session-id'], 'fixture-session');
  assert.equal(requests[2].headers.authorization, undefined);
  assert.deepEqual(requests[0].body.params.capabilities, {});
});

test('unsafe endpoints, disabled configuration and extra tool arguments fail before network', async () => {
  let calls = 0;
  const options = { transport: async () => { calls++; throw new Error('unexpected'); } };
  const config = { enabled: true, endpoint: 'http://127.0.0.1:8900/mcp' };
  for (const endpoint of ['http://example.org/mcp', 'http://localhost:8900/mcp', 'http://user:pass@127.0.0.1/mcp',
    'http://127.0.0.1/mcp?token=secret', 'http://127.0.0.1/admin'])
    await assert.rejects(() => collectNews({ ...config, endpoint }, query, options));
  await assert.rejects(() => collectNews({ ...config, enabled: false }, query, options));
  await assert.rejects(() => collectNews(config, { ...query, name: 'bash' }, options));
  await assert.rejects(() => collectNews(config, { ...query, code: 'RELIANCE.NS' }, options));
  assert.equal(calls, 0);
});

for (const [name, behavior] of Object.entries({
  redirect: { redirect: true }, wrongId: { wrongId: true }, protocol: { protocol: 'unknown' },
  scope: { news: { ...news, data: { ...news.data, code: 'OTHER.US' } } },
  error: { isError: true }, oversized: { oversize: true },
})) test(`rejects ${name} without submitting evidence`, async t => {
  const { config, requests } = await peer(t, behavior);
  await assert.rejects(() => collectNews(config, query), /News collection failed/);
  assert.ok(requests.length <= 4);
  if (!behavior.redirect) assert.equal(requests.at(-1).method, 'DELETE');
});

test('timeout ends a stalled call and attempts session cleanup', async t => {
  const { config, requests } = await peer(t, { hang: true });
  await assert.rejects(() => collectNews({ ...config, timeoutMs: 300 }, query), /News collection failed/);
  assert.equal(requests.at(-1).method, 'DELETE');
});

test('records cleanup refusal without discarding collected news', async t => {
  const { config } = await peer(t, { cleanupStatus: 405 });
  assert.equal((await collectNews(config, query)).cleanup, 'unsupported');
});

test('saves replayable artifacts and never overwrites an existing collection', async t => {
  const { config, requests } = await peer(t);
  const directory = await mkdtemp(join(tmpdir(), 'vibe-collect-'));
  try {
    const destination = join(directory, 'run');
    const policy = { sources: [{ origin: 'https://publisher.example', sourceId: 'fixture' }] };
    const value = await saveCollection(config, query, policy, destination);
    assert.equal(value.submitted, false);
    assert.deepEqual(JSON.parse(await readFile(join(destination, 'news.json'), 'utf8')), news);
    assert.equal(JSON.parse(await readFile(join(destination, 'prepared.json'), 'utf8')).observations.length, 1);
    assert.equal(JSON.parse(await readFile(join(destination, 'complete.json'), 'utf8')).submitted, false);
    await assert.rejects(() => saveCollection(config, query, policy, destination), { code: 'EEXIST' });
    assert.equal(requests.length, 4);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
