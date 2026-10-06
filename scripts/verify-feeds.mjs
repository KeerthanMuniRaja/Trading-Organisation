import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, key, owner, evaluator } from '../backend/dist/test/helpers.js';
import { createApp } from '../backend/dist/src/app.js';
import { importBatch } from './import-observations.mjs';
import { abandonRun, feedStatus, runFeedCycle } from './run-feed-cycle.mjs';

// Isolated DATA-01 check: real backend HTTP, real loopback publisher, ephemeral credentials and an in-memory
// database. It never reads .env, contacts an external publisher or touches the persistent community.
const startedAt = new Date().toISOString();
const HOUR = 3600000;
let f, app, server, root, report;
try {
  f = await fixture();
  await f.org.sources(owner, key(), { id: 'publisher', name: 'Synthetic publisher', url: 'https://publisher.example', approved: true });
  app = await createApp(f.cfg, f.db, true); await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const token = role => f.cfg.principals.find(p => p.role === role).token;
  const env = { API_URL: new URL(base).origin, PRINCIPALS_JSON: JSON.stringify(f.cfg.principals.filter(p => p.role === 'researcher')) };

  const publisher = { etag: '"v1"', items: [1, 2], corrected: false, hits: [] };
  const item = n => `<item><title>Synthetic story ${n}</title><link>https://publisher.example/story/${n}</link>` +
    `<description>&lt;p&gt;Fees and slippage reduce net returns (${n}${publisher.corrected && n === 2 ? ', corrected' : ''}).&lt;/p&gt;</description>` +
    `<pubDate>${new Date(Date.UTC(2026, 0, 1, 9, n)).toUTCString()}</pubDate></item>`;
  server = createServer((request, response) => {
    publisher.hits.push({ path: request.url, ifNoneMatch: request.headers['if-none-match'] ?? null, auth: 'authorization' in request.headers });
    if (request.headers['if-none-match'] === publisher.etag) { response.writeHead(304); response.end(); return; }
    response.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8', etag: publisher.etag });
    response.end(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Synthetic</title>${publisher.items.map(item).join('')}</channel></rss>`);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const config = { enabled: true, feedUrl: `http://127.0.0.1:${server.address().port}/feed.xml`, pollIntervalMinutes: 15,
    sources: [{ origin: 'https://publisher.example', sourceId: 'publisher' }] };
  root = await mkdtemp(join(tmpdir(), 'feed-verify-'));
  const state = join(root, 'state');
  let clock = Date.now(), loseNext = false, backendCalls = 0;
  const lossy = async (url, options) => {
    backendCalls++;
    const response = await fetch(url, options);
    if (loseNext) { loseNext = false; await response.body?.cancel(); throw new Error('injected lost acknowledgement'); }
    return response;
  };
  const options = { env, allowLoopbackHttp: true, now: () => clock, submit: (rows, e) => importBatch(rows, e, lossy) };
  const observations = async () => (await f.org.observations().list(owner, { sourceId: 'publisher' })).observations;
  const checks = [];

  // 1. Lost acknowledgement after backend acceptance; the restarted worker resumes the saved snapshot.
  loseNext = true;
  await assert.rejects(runFeedCycle(config, state, options), /not fully acknowledged/);
  publisher.items = [1, 2, 3]; // Publisher changes meanwhile; recovery must not refetch.
  const resumed = await runFeedCycle(config, state, options);
  // The replayed idempotency key returns the original receipt, so deduplication shows in the stored rows.
  assert.equal(resumed.resumed, true); assert.equal(resumed.submitted, 2);
  assert.equal(publisher.hits.length, 1); assert.equal((await observations()).length, 2);
  checks.push('lost-acknowledgement-resumed-without-refetch-or-duplicate');

  // 2. Politeness and conditional requests.
  assert.equal((await runFeedCycle(config, state, options)).state, 'not-due');
  publisher.items = [1, 2]; clock += 15 * 60000;
  assert.equal((await runFeedCycle(config, state, options)).state, 'not-modified');
  assert.equal(publisher.hits.at(-1).ifNoneMatch, '"v1"');
  checks.push('poll-interval-and-etag-respected');

  // 3. New entry plus a corrected entry: one new evidence each; the earlier revision is retained.
  publisher.items = [1, 2, 3]; publisher.corrected = true; publisher.etag = '"v2"'; clock += 15 * 60000;
  const updated = await runFeedCycle(config, state, options);
  assert.equal(updated.state, 'awaiting-review'); assert.equal(updated.newEvidence, 2); assert.equal(updated.alreadySeen, 1);
  const rows = await observations();
  assert.equal(rows.length, 4); assert.ok(rows.every(r => r.status === 'unverified' && r.usable === false));
  assert.equal(rows.filter(r => r.url === 'https://publisher.example/story/2').length, 2);
  checks.push('correction-creates-separate-unverified-revision');

  // 4. Evidence remains unverified until an independent evaluator reviews it through the existing route.
  const queue = await (await fetch(base + '/v1/sources/observations/review-queue', { method: 'POST',
    headers: { Authorization: 'Bearer ' + token('evaluator'), 'Content-Type': 'application/json' }, body: '{}' })).json();
  assert.equal(queue.observations.length, 4);
  await f.org.reviewEvidence(evaluator, key(), { evidenceId: updated.evidenceIds[0], status: 'verified' });
  assert.equal((await observations()).filter(r => r.usable).length, 1);
  checks.push('independent-review-required');

  // 5. Source withdrawal blocks new ingestion; the run stays recoverable and can be explicitly abandoned.
  await f.org.revoke(owner, key(), { kind: 'source', targetId: 'publisher', reason: 'Verification: owner withdraws publisher' });
  publisher.items = [1, 2, 3, 4]; publisher.etag = '"v3"'; clock += 15 * 60000;
  await assert.rejects(runFeedCycle(config, state, options), /not fully acknowledged/);
  assert.equal((await feedStatus(state)).activeRunFiles['selection.json'], true);
  assert.equal((await abandonRun(state, 'Publisher withdrawn by owner during verification')).state, 'abandoned');
  assert.equal((await observations()).length, 4);
  checks.push('source-withdrawal-blocks-and-run-can-be-abandoned');

  assert.ok(publisher.hits.every(h => !h.auth), 'Backend credentials must never reach the publisher');
  assert.equal((await f.treasury.snapshot(owner)).wallet1Paise, '0');
  assert.equal((await f.ops.verifyAudit(owner)).valid, true);
  checks.push('no-credentials-to-publisher-no-financial-writes-audit-valid');
  report = { status: 'passed', startedAt, finishedAt: new Date().toISOString(), checks, publisherRequests: publisher.hits.length,
    backendRequests: backendCalls, observations: (await observations()).length,
    scope: 'Loopback synthetic publisher and in-memory backend; no external publisher, model, persistent worker or financial service' };
} catch (error) { report = { status: 'failed', startedAt, message: error.message, at: error.stack?.split('\n')[1]?.trim() }; process.exitCode = 1; }
finally {
  if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
  if (app) await app.close(); if (f) await f.db.close();
  if (root) await rm(root, { recursive: true, force: true });
}
await mkdir('.local', { recursive: true });
await writeFile('.local/feed-verification.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
