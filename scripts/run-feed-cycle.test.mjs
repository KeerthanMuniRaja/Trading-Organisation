import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { abandonRun, feedStatus, runFeedCycle, runFeedSession } from './run-feed-cycle.mjs';

const config = { enabled: true, feedUrl: 'https://feeds.publisher.example/markets.xml', maxItemsPerCycle: 20,
  pollIntervalMinutes: 60, sources: [{ origin: 'https://publisher.example', sourceId: 'publisher' }] };
const env = { API_URL: 'http://127.0.0.1:3000', PRINCIPALS_JSON: JSON.stringify([{ role: 'researcher', token: 'test-only-token' }]) };
const T0 = Date.parse('2026-10-06T10:00:00Z'), HOUR = 3600000;
const item = (n, summary = 'Summary ' + n) =>
  `<item><title>Story ${n}</title><link>https://publisher.example/${n}</link><description>${summary}</description>` +
  `<pubDate>${new Date(Date.parse('2026-10-06T00:00:00Z') + n * 60000).toUTCString()}</pubDate></item>`;
const rss = (...items) => `<rss version="2.0"><channel>${items.join('')}</channel></rss>`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'feed-cycle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = { body: rss(item(1), item(2)), etag: '"v1"', status: 200, clock: T0, fetches: [], submitted: [], failSubmit: 0 };
  const transport = async (url, options) => {
    state.fetches.push({ url, headers: options.headers });
    if (state.status === 'throw') throw new Error('network down');
    if (state.status !== 200) return new Response(null, { status: state.status, headers: state.headers ?? {} });
    if (options.headers['If-None-Match'] === state.etag) return new Response(null, { status: 304 });
    return new Response(state.body, { status: 200, headers: { 'content-type': 'application/rss+xml', etag: state.etag } });
  };
  // Stand-in for the backend importer: records exact rows; can lose acknowledgements after acceptance.
  const accepted = new Map();
  const submit = async rows => {
    const results = [];
    for (const row of rows) {
      const key = JSON.stringify(row);
      const duplicate = accepted.has(key);
      if (!duplicate) accepted.set(key, 'evidence-' + accepted.size);
      state.submitted.push(row);
      if (state.failSubmit > 0) { state.failSubmit--; throw new Error('lost acknowledgement'); }
      results.push({ id: accepted.get(key), status: 'unverified', duplicate });
    }
    return { submitted: results.length, results };
  };
  const options = { env, transport, submit, now: () => state.clock };
  return { dir: join(root, 'feed'), state, accepted, options };
}

test('first cycle submits; conditional refetch is polite and deduplicated', async t => {
  const f = await fixture(t);
  const first = await runFeedCycle(config, f.dir, f.options);
  assert.equal(first.state, 'awaiting-review');
  assert.equal(first.submitted, 2);
  assert.equal(first.newEvidence, 2);
  assert.equal(first.reviewRequired, true);
  assert.deepEqual(f.state.submitted.map(r => r.title), ['Story 1', 'Story 2']);
  assert.equal(first.nextFetchAt, new Date(T0 + HOUR).toISOString());
  const early = await runFeedCycle(config, f.dir, f.options);
  assert.equal(early.state, 'not-due');
  assert.equal(f.state.fetches.length, 1);
  f.state.clock = T0 + HOUR;
  const second = await runFeedCycle(config, f.dir, f.options);
  assert.equal(second.state, 'not-modified');
  assert.equal(f.state.fetches[1].headers['If-None-Match'], '"v1"');
  f.state.clock += HOUR; f.state.etag = '"v2"'; f.state.body = rss(item(1), item(2), item(3));
  const third = await runFeedCycle(config, f.dir, f.options);
  assert.equal(third.submitted, 1);
  assert.equal(third.alreadySeen, 2);
  for (const name of ['manifest.json', 'checkpoint.json']) assert.ok(!(await readFile(join(f.dir, name), 'utf8')).includes('test-only-token'));
});

test('a lost acknowledgement resumes the saved run without refetching or changing rows', async t => {
  const f = await fixture(t);
  f.state.failSubmit = 1;
  await assert.rejects(runFeedCycle(config, f.dir, f.options), /not fully acknowledged/);
  assert.equal((await feedStatus(f.dir)).activeRunFiles['selection.json'], true);
  f.state.body = rss(item(9)); // The publisher changes; recovery must use the saved snapshot.
  const resumed = await runFeedCycle(config, f.dir, f.options);
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.state, 'awaiting-review');
  assert.equal(f.state.fetches.length, 1);
  assert.deepEqual(f.state.submitted.map(r => r.title), ['Story 1', 'Story 1', 'Story 2']);
  assert.equal(resumed.backendDuplicates, 1);
  assert.equal(f.accepted.size, 2);
});

test('corrections create one new revision; capacity keeps the newest and reports the rest', async t => {
  const f = await fixture(t);
  await runFeedCycle(config, f.dir, f.options);
  f.state.clock += HOUR; f.state.etag = '"v2"'; f.state.body = rss(item(1), item(2, 'Corrected summary 2'));
  const corrected = await runFeedCycle(config, f.dir, f.options);
  assert.equal(corrected.submitted, 1);
  assert.match(f.state.submitted.at(-1).content, /Corrected summary 2/);
  f.state.clock += HOUR; f.state.etag = '"v3"'; f.state.body = rss(...[3, 4, 5, 6, 7].map(n => item(n)));
  const capped = await runFeedCycle({ ...config, maxItemsPerCycle: 2 }, join(f.dir, '..', 'capped'), f.options);
  assert.equal(capped.submitted, 2);
  assert.equal(capped.skippedOverCapacity, 3);
  assert.deepEqual(f.state.submitted.slice(-2).map(r => r.title), ['Story 6', 'Story 7']);
});

test('fetch failures back off exponentially and honour Retry-After', async t => {
  const f = await fixture(t);
  f.state.status = 'throw';
  const failed = await runFeedCycle(config, f.dir, f.options);
  assert.equal(failed.state, 'fetch-failed');
  assert.equal(failed.code, 'FEED_UNREACHABLE');
  assert.equal(failed.nextFetchAt, new Date(T0 + HOUR).toISOString());
  f.state.clock = T0 + 30 * 60000;
  assert.equal((await runFeedCycle(config, f.dir, f.options)).state, 'backoff');
  f.state.clock = T0 + HOUR;
  assert.equal((await runFeedCycle(config, f.dir, f.options)).nextFetchAt, new Date(T0 + 3 * HOUR).toISOString());
  f.state.clock = T0 + 3 * HOUR; f.state.status = 429; f.state.headers = { 'retry-after': String(20 * 3600) };
  const limited = await runFeedCycle(config, f.dir, f.options);
  assert.equal(limited.code, 'FEED_RATE_LIMITED');
  assert.equal(limited.nextFetchAt, new Date(T0 + 23 * HOUR).toISOString());
  f.state.clock = T0 + 23 * HOUR; f.state.status = 200;
  const recovered = await runFeedCycle(config, f.dir, f.options);
  assert.equal(recovered.state, 'awaiting-review');
  assert.equal((await feedStatus(f.dir)).consecutiveFailures, 0);
});

test('crash after a fetch failure preserves Retry-After and failure count exactly once', async t => {
  const f = await fixture(t);
  f.state.status = 429; f.state.headers = { 'retry-after': '21600' };
  const failed = await runFeedCycle(config, f.dir, f.options);
  const p = join(f.dir, 'checkpoint.json');
  const saved = JSON.parse(await readFile(p, 'utf8'));
  // The journal reached disk, but the final checkpoint did not.
  await writeFile(p, JSON.stringify({ ...saved, activeRun: failed.runId, consecutiveFailures: 0,
    lastFailureCode: null, nextAttemptAt: null }));
  const recovered = await runFeedCycle(config, f.dir, f.options);
  assert.equal(recovered.resumed, true);
  assert.equal(recovered.nextFetchAt, new Date(T0 + 6 * HOUR).toISOString());
  assert.equal((await feedStatus(f.dir)).consecutiveFailures, 1);
  f.state.clock += HOUR;
  assert.equal((await runFeedCycle(config, f.dir, f.options)).state, 'backoff');
  assert.equal((await feedStatus(f.dir)).consecutiveFailures, 1);
  assert.equal(f.state.fetches.length, 1);
});

test('crash after a 304 clears prior failures without refetching', async t => {
  const f = await fixture(t);
  await runFeedCycle(config, f.dir, f.options);
  f.state.clock += HOUR; f.state.status = 'throw';
  await runFeedCycle(config, f.dir, f.options);
  const p = join(f.dir, 'checkpoint.json');
  const before = JSON.parse(await readFile(p, 'utf8'));
  f.state.clock += HOUR; f.state.status = 304;
  const success = await runFeedCycle(config, f.dir, f.options);
  await writeFile(p, JSON.stringify({ ...before, activeRun: success.runId, lastAttemptAt: new Date(f.state.clock).toISOString() }));
  const recovered = await runFeedCycle(config, f.dir, f.options);
  assert.equal(recovered.state, 'not-modified');
  const status = await feedStatus(f.dir);
  assert.equal(status.consecutiveFailures, 0);
  assert.equal(status.nextAttemptAt, null);
  assert.equal(status.lastSuccessAt, new Date(f.state.clock).toISOString());
  assert.equal(f.state.fetches.length, 3);
});

test('unparseable feeds are retained, do not advance validators and back off', async t => {
  const f = await fixture(t);
  f.state.body = '<!DOCTYPE x [<!ENTITY a "b">]><rss/>';
  const failed = await runFeedCycle(config, f.dir, f.options);
  assert.equal(failed.state, 'parse-failed');
  assert.equal(f.state.submitted.length, 0);
  const status = await feedStatus(f.dir);
  assert.equal(status.etag, null);
  assert.equal(status.lastFailureCode, 'FEED_PARSE_ERROR');
  const runs = await readdir(join(f.dir, 'runs'));
  assert.equal(await readFile(join(f.dir, 'runs', runs[0], 'feed.xml'), 'utf8'), f.state.body);
});

test('crash recovery: discarded unsaved fetch, and an outcome is applied exactly once', async t => {
  const f = await fixture(t);
  // Simulate a crash after registering a run but before the fetched bytes were saved.
  await runFeedCycle(config, f.dir, f.options);
  const checkpointPath = join(f.dir, 'checkpoint.json');
  const saved = JSON.parse(await readFile(checkpointPath, 'utf8'));
  await writeFile(checkpointPath, JSON.stringify({ ...saved, activeRun: 'crashed-run' }));
  const discarded = await runFeedCycle(config, f.dir, f.options);
  assert.equal(discarded.state, 'interrupted-fetch-discarded');
  assert.equal(f.state.fetches.length, 1);
  // Simulate a crash after the outcome was saved but before the checkpoint update.
  const [completed] = (await readdir(join(f.dir, 'runs'))).filter(r => r !== 'crashed-run');
  await writeFile(checkpointPath, JSON.stringify({ ...saved, activeRun: completed, seen: [], etag: null }));
  const applied = await runFeedCycle(config, f.dir, f.options);
  assert.equal(applied.resumed, true);
  assert.equal(f.state.submitted.length, 2);
  const status = await feedStatus(f.dir);
  assert.equal(status.seenCount, 2);
  assert.equal(status.etag, '"v1"');
});

test('abandoning a stuck run keeps its entries unseen for a later attempt', async t => {
  const f = await fixture(t);
  f.state.failSubmit = 10;
  await assert.rejects(runFeedCycle(config, f.dir, f.options));
  await assert.rejects(abandonRun(f.dir, ''), /reason/);
  const abandoned = await abandonRun(f.dir, 'Source withdrawn by owner; inspected run.');
  assert.equal(abandoned.state, 'abandoned');
  await assert.rejects(abandonRun(f.dir, 'again'), /No unfinished run/);
  f.state.failSubmit = 0; f.state.clock += HOUR;
  const retried = await runFeedCycle(config, f.dir, f.options);
  assert.equal(retried.state, 'awaiting-review');
  assert.equal(f.state.fetches.at(-1).headers['If-None-Match'], undefined);
});

test('changed configuration or credential cannot adopt existing state; locks exclude a second worker', async t => {
  const f = await fixture(t);
  await runFeedCycle(config, f.dir, f.options);
  await assert.rejects(runFeedCycle({ ...config, maxItemsPerCycle: 5 }, f.dir, f.options), /configuration or backend identity changed/);
  const other = { ...env, PRINCIPALS_JSON: JSON.stringify([{ role: 'researcher', token: 'different' }]) };
  await assert.rejects(runFeedCycle(config, f.dir, { ...f.options, env: other }), /changed/);
  await writeFile(join(f.dir, 'feed.lock'), '');
  await assert.rejects(runFeedCycle(config, f.dir, f.options), /locked/);
  const orphan = join(f.dir, '..', 'orphan');
  await mkdir(join(orphan, 'runs'), { recursive: true });
  await assert.rejects(runFeedCycle(config, orphan, f.options), /Orphaned/);
  assert.equal((await feedStatus(join(f.dir, '..', 'missing'))).state, 'no-state');
});

test('finite session waits for the poll interval and stops at its deadline', async t => {
  const f = await fixture(t);
  const logs = [], sleeps = [];
  const sleep = async ms => { sleeps.push(ms); f.state.clock += ms; };
  const result = await runFeedSession(config, f.dir, 150, { ...f.options, sleep }, value => logs.push(value));
  assert.equal(result.state, 'session-ended');
  assert.deepEqual(logs.map(l => l.state), ['awaiting-review', 'not-modified', 'not-modified']);
  assert.deepEqual(sleeps, [HOUR, HOUR]);
  await assert.rejects(runFeedSession(config, f.dir, 0, f.options), /1–360/);
});
