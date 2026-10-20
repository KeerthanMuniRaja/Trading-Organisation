import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { backendBinding, exists, lockDirectory, readBoundedJson, save, saveBytes, stableHash } from './cycle-state.mjs';
import { importBatch, observationKey } from './import-observations.mjs';
import { FeedFetchError, fetchFeed, validateFeedConfig } from '../integrations/publisher-feeds/feed-client.mjs';
import { FeedFormatError, MAX_FEED_BYTES, prepareFeed } from '../integrations/publisher-feeds/feed-parser.mjs';

const SEEN_LIMIT = 2000, MAX_BACKOFF_MS = 86400000, SUBMIT_BATCH = 25;
const iso = ms => new Date(ms).toISOString();
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const initial = () => ({ version: 1, etag: null, lastModified: null, lastAttemptAt: null, lastSuccessAt: null,
  consecutiveFailures: 0, lastFailureCode: null, nextAttemptAt: null, activeRun: null, completedRuns: 0, seen: [] });
const layout = directory => ({ directory, manifest: join(directory, 'manifest.json'),
  checkpoint: join(directory, 'checkpoint.json'), runs: join(directory, 'runs') });

/** Publisher politeness: never earlier than one poll interval after the last attempt, nor during backoff. */
function nextFetchAt(checkpoint, feed) {
  const times = [checkpoint.nextAttemptAt,
    checkpoint.lastAttemptAt && iso(Date.parse(checkpoint.lastAttemptAt) + feed.pollIntervalMinutes * 60000)].filter(Boolean);
  return times.length ? times.reduce((a, b) => Date.parse(a) >= Date.parse(b) ? a : b) : null;
}
function backoff(feed, failures, from, retryAfterMs = null) {
  const exponential = feed.pollIntervalMinutes * 60000 * 2 ** Math.min(failures - 1, 10);
  return iso(from + Math.min(MAX_BACKOFF_MS, Math.max(exponential, retryAfterMs ?? 0)));
}
async function readCheckpoint(paths) {
  if (!await exists(paths.checkpoint)) return initial();
  const value = await readBoundedJson(paths.checkpoint, 524288);
  if (value?.version !== 1 || !Array.isArray(value.seen) || !Number.isInteger(value.consecutiveFailures) ||
      (value.activeRun !== null && !/^[\w-]{1,80}$/.test(value.activeRun))) throw new Error('Feed checkpoint is invalid; inspect it before recovery');
  return value;
}
async function bindManifest(paths, fingerprint) {
  if (await exists(paths.manifest)) {
    const manifest = await readBoundedJson(paths.manifest, 4096);
    if (manifest.version !== 1 || manifest.fingerprint !== fingerprint) throw new Error('Feed configuration or backend identity changed; use a new state directory');
    return;
  }
  // Refuse to adopt another feed's checkpoint or runs under a new configuration.
  if (await exists(paths.checkpoint) || await exists(paths.runs)) throw new Error('Orphaned feed state requires manual inspection');
  await save(paths.manifest, { version: 1, fingerprint, createdAt: new Date().toISOString() });
}

/** Applies a durable run outcome to the checkpoint. Repeating it after a crash produces the same checkpoint. */
async function applyOutcome(paths, feed, checkpoint, runId, outcome) {
  const runDir = join(paths.runs, runId);
  let next = { ...checkpoint, activeRun: null };
  if (outcome.state === 'awaiting-review' || outcome.state === 'no-new-items') {
    const fetched = await readBoundedJson(join(runDir, 'fetch.json'), 8192);
    const selection = await readBoundedJson(join(runDir, 'selection.json'), 1048576);
    const retain = new Set(selection.retainKeys);
    next = { ...next, etag: fetched.etag, lastModified: fetched.lastModified, consecutiveFailures: 0, lastFailureCode: null,
      nextAttemptAt: null, lastSuccessAt: fetched.fetchedAt, completedRuns: checkpoint.completedRuns + 1,
      // Keys still present in the feed are refreshed so they do not age out of the bounded window.
      seen: [...checkpoint.seen.filter(k => !retain.has(k)), ...selection.retainKeys].slice(-SEEN_LIMIT) };
  } else if (outcome.state === 'fetch-failed') {
    const failures = checkpoint.consecutiveFailures + 1;
    next = { ...next, consecutiveFailures: failures, lastFailureCode: outcome.code,
      // Older outcomes lack Retry-After. Recover their exponential backoff without inventing a publisher value.
      nextAttemptAt: outcome.retryAt ?? backoff(feed, failures, Date.parse(checkpoint.lastAttemptAt)) };
  } else if (outcome.state === 'not-modified') {
    next = { ...next, consecutiveFailures: 0, lastFailureCode: null, nextAttemptAt: null,
      lastSuccessAt: checkpoint.lastAttemptAt };
  } else if (outcome.state === 'parse-failed') {
    const failures = checkpoint.consecutiveFailures + 1;
    const fetched = await readBoundedJson(join(runDir, 'fetch.json'), 8192);
    next = { ...next, consecutiveFailures: failures, lastFailureCode: outcome.code,
      nextAttemptAt: backoff(feed, failures, Date.parse(fetched.fetchedAt)) };
  }
  await save(paths.checkpoint, next);
  return { ...outcome, runId, nextFetchAt: nextFetchAt(next, feed) };
}

async function finishRun(paths, feed, checkpoint, runId, { env, submit }) {
  const runDir = join(paths.runs, runId), outcomePath = join(runDir, 'outcome.json');
  if (await exists(outcomePath)) return applyOutcome(paths, feed, checkpoint, runId, await readBoundedJson(outcomePath, 1048576));
  if (!await exists(join(runDir, 'feed.xml')) || !await exists(join(runDir, 'fetch.json'))) {
    // Interrupted before the fetched bytes were durably recorded: nothing was parsed or submitted.
    await mkdir(runDir, { recursive: true });
    const outcome = { state: 'interrupted-fetch-discarded', finishedAt: new Date().toISOString() };
    await save(outcomePath, outcome);
    return applyOutcome(paths, feed, checkpoint, runId, outcome);
  }
  const fetched = await readBoundedJson(join(runDir, 'fetch.json'), 8192);
  const bytes = await readFile(join(runDir, 'feed.xml'));
  if (bytes.length > MAX_FEED_BYTES || sha256(bytes) !== fetched.sha256 || fetched.feedUrl !== feed.feedUrl)
    throw new Error('Saved feed snapshot does not match its fetch record; inspect the run');
  const selectionPath = join(runDir, 'selection.json');
  let selection;
  if (await exists(selectionPath)) selection = await readBoundedJson(selectionPath, 1048576);
  else {
    let prepared;
    try { prepared = prepareFeed(bytes, feed, Date.parse(fetched.fetchedAt)); }
    catch (error) {
      if (!(error instanceof FeedFormatError)) throw error;
      const outcome = { state: 'parse-failed', code: 'FEED_PARSE_ERROR', finishedAt: new Date().toISOString() };
      await save(outcomePath, outcome);
      return applyOutcome(paths, feed, checkpoint, runId, outcome);
    }
    const seen = new Set(checkpoint.seen);
    const rows = prepared.observations.map(row => ({ row, key: observationKey(row) }));
    const fresh = rows.filter(x => !seen.has(x.key));
    const newestFirst = (a, b) => b.row.publishedAt.localeCompare(a.row.publishedAt) || a.key.localeCompare(b.key);
    // Capacity keeps the newest unseen entries; they are then submitted oldest first.
    const chosen = fresh.sort(newestFirst).slice(0, feed.maxItemsPerCycle).reverse();
    selection = { format: prepared.format, rawHash: prepared.provenance.rawHash, truncated: prepared.truncated,
      observations: chosen.map(x => x.row), keys: chosen.map(x => x.key),
      retainKeys: [...rows.filter(x => seen.has(x.key)).map(x => x.key), ...chosen.map(x => x.key)],
      alreadySeen: rows.length - fresh.length, skippedOverCapacity: fresh.length - chosen.length, rejected: prepared.rejected };
    await save(selectionPath, selection);
  }
  const results = [];
  try {
    for (let i = 0; i < selection.observations.length; i += SUBMIT_BATCH)
      // The backend importer uses its own transport; the publisher transport never carries credentials.
      results.push(...(await submit(selection.observations.slice(i, i + SUBMIT_BATCH), env)).results);
  } catch {
    throw new Error(`Feed run ${runId} was not fully acknowledged (${results.length} confirmed this attempt). ` +
      'Rerun with unchanged inputs to resume with identical idempotency keys, or abandon the run after inspection.');
  }
  const outcome = { state: selection.observations.length ? 'awaiting-review' : 'no-new-items', submitted: results.length,
    newEvidence: results.filter(r => !r.duplicate).length, backendDuplicates: results.filter(r => r.duplicate).length,
    evidenceIds: results.map(r => r.id), alreadySeen: selection.alreadySeen, skippedOverCapacity: selection.skippedOverCapacity,
    rejected: selection.rejected, truncated: selection.truncated, format: selection.format, rawHash: selection.rawHash,
    finishedAt: new Date().toISOString(), reviewRequired: true };
  await save(outcomePath, outcome);
  return applyOutcome(paths, feed, checkpoint, runId, outcome);
}

/**
 * At most one network fetch per invocation. An unfinished run is completed first from saved bytes
 * without fetching. Evidence acceptance remains with an independent backend reviewer.
 */
export async function runFeedCycle(config, destination, { env = process.env, transport = fetch, submit = importBatch,
  now = Date.now, allowLoopbackHttp = false, signal } = {}) {
  const feed = validateFeedConfig(config, { allowLoopbackHttp });
  const fingerprint = stableHash({ version: 1, feed, backend: backendBinding(env) });
  const { directory, release } = await lockDirectory(destination, 'feed.lock', 'Feed state');
  try {
    const paths = layout(directory);
    await bindManifest(paths, fingerprint);
    let checkpoint = await readCheckpoint(paths);
    const deps = { env, submit };
    if (checkpoint.activeRun) return { ...await finishRun(paths, feed, checkpoint, checkpoint.activeRun, deps), resumed: true };
    const started = now();
    const due = nextFetchAt(checkpoint, feed);
    if (due && started < Date.parse(due))
      return { state: checkpoint.consecutiveFailures ? 'backoff' : 'not-due', nextFetchAt: due, resumed: false };
    const runId = iso(started).replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
    // The run is registered before contacting the publisher, so a crash leaves a recoverable record.
    checkpoint = { ...checkpoint, activeRun: runId, lastAttemptAt: iso(started) };
    await save(paths.checkpoint, checkpoint);
    const runDir = join(paths.runs, runId);
    await mkdir(runDir, { recursive: true });
    let fetched;
    try { fetched = await fetchFeed(feed, checkpoint, { transport, signal, now: started }); }
    catch (error) {
      const code = error instanceof FeedFetchError ? error.code : 'FEED_FETCH_FAILED';
      const failures = checkpoint.consecutiveFailures + 1;
      const outcome = { state: 'fetch-failed', code, finishedAt: new Date().toISOString(),
        retryAt: backoff(feed, failures, started, error.retryAfterMs) };
      await save(join(runDir, 'outcome.json'), outcome);
      return { ...await applyOutcome(paths, feed, checkpoint, runId, outcome), consecutiveFailures: failures, resumed: false };
    }
    if (fetched.status === 'not-modified') {
      const outcome = { state: 'not-modified', finishedAt: new Date().toISOString() };
      await save(join(runDir, 'outcome.json'), outcome);
      return { ...await applyOutcome(paths, feed, checkpoint, runId, outcome), resumed: false };
    }
    // Bytes are durable before parsing, so parser or submission failures never require a refetch.
    await saveBytes(join(runDir, 'feed.xml'), fetched.bytes);
    await save(join(runDir, 'fetch.json'), { feedUrl: feed.feedUrl, fetchedAt: iso(started), httpStatus: fetched.httpStatus,
      etag: fetched.etag, lastModified: fetched.lastModified, bytes: fetched.bytes.length, sha256: sha256(fetched.bytes) });
    return { ...await finishRun(paths, feed, checkpoint, runId, deps), resumed: false };
  } finally { await release(); }
}

/** Operator closes an unfinished run (for example after source withdrawal). Its entries are not marked seen. */
export async function abandonRun(destination, reason) {
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 300) throw new Error('Provide a reason of 1–300 characters');
  if (!await exists(resolve(destination, 'checkpoint.json'))) throw new Error('No feed state found');
  const { directory, release } = await lockDirectory(destination, 'feed.lock', 'Feed state');
  try {
    const paths = layout(directory), checkpoint = await readCheckpoint(paths);
    if (!checkpoint.activeRun) throw new Error('No unfinished run to abandon');
    const runDir = join(paths.runs, checkpoint.activeRun);
    if (await exists(join(runDir, 'outcome.json'))) throw new Error('Run already has an outcome; rerun the cycle to apply it');
    await mkdir(runDir, { recursive: true });
    const outcome = { state: 'abandoned', reason: reason.trim(), finishedAt: new Date().toISOString() };
    await save(join(runDir, 'outcome.json'), outcome);
    await save(paths.checkpoint, { ...checkpoint, activeRun: null });
    return { ...outcome, runId: checkpoint.activeRun };
  } finally { await release(); }
}

/** Read-only local snapshot. It does not contact the publisher or backend and does not prove liveness. */
export async function feedStatus(destination) {
  const paths = layout(resolve(destination));
  if (!await exists(paths.checkpoint)) return { state: 'no-state' };
  const { seen, ...checkpoint } = await readCheckpoint(paths);
  let activeRunFiles = null;
  if (checkpoint.activeRun) {
    const runDir = join(paths.runs, checkpoint.activeRun);
    activeRunFiles = Object.fromEntries(await Promise.all(['fetch.json', 'feed.xml', 'selection.json', 'outcome.json']
      .map(async name => [name, await exists(join(runDir, name))])));
  }
  return { ...checkpoint, seenCount: seen.length, activeRunFiles, scope: 'local-snapshot-only' };
}

const pause = (ms, signal) => new Promise(done => {
  const timer = setTimeout(done, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); done(); }, { once: true });
});
/** Finite polling session (1–360 minutes). Stops after three consecutive cycle errors. */
export async function runFeedSession(config, destination, minutes, options = {}, log = console.log) {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 360) throw new Error('Session must be 1–360 minutes');
  const clock = options.now ?? Date.now, sleep = options.sleep ?? pause, signal = options.signal;
  const end = clock() + minutes * 60000;
  let cycles = 0, errors = 0;
  while (!signal?.aborted && clock() < end) {
    let wait;
    try {
      const result = await runFeedCycle(config, destination, options);
      cycles++; errors = 0; log(result);
      wait = result.nextFetchAt ? Date.parse(result.nextFetchAt) - clock() : 60000;
    } catch (error) {
      if (++errors >= 3) throw error;
      log({ state: 'cycle-error', consecutiveErrors: errors, message: error.code ? 'Local state error' : error.message });
      wait = 60000;
    }
    wait = Math.max(wait, 5000);
    if (clock() + wait >= end) break;
    await sleep(wait, signal);
  }
  return { state: signal?.aborted ? 'interrupted' : 'session-ended', cycles };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const usage = 'Usage: run FEED.json STATE_DIR [--minutes N] | status STATE_DIR | abandon STATE_DIR --reason TEXT';
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'run' && (args.length === 2 || (args.length === 4 && args[2] === '--minutes'))) {
      const config = await readBoundedJson(args[0], 65536);
      if (args.length === 2) {
        const result = await runFeedCycle(config, args[1]);
        console.log(JSON.stringify(result));
        if (['fetch-failed', 'parse-failed'].includes(result.state)) process.exitCode = 1;
      } else {
        const controller = new AbortController();
        process.once('SIGINT', () => controller.abort());
        console.log(JSON.stringify(await runFeedSession(config, args[1], Number(args[3]), { signal: controller.signal },
          value => console.log(JSON.stringify(value)))));
      }
    } else if (command === 'status' && args.length === 1) console.log(JSON.stringify(await feedStatus(args[0]), null, 2));
    else if (command === 'abandon' && args.length === 3 && args[1] === '--reason') console.log(JSON.stringify(await abandonRun(args[0], args[2])));
    else throw new Error(usage);
  } catch (error) {
    // Filesystem errors can expose local paths; our own validation and recovery messages are safe to print.
    console.error(error.code ? 'Feed state could not be read or written; inspect the state directory' : error.message);
    process.exitCode = 1;
  }
}
