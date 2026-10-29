// World news intelligence (NEWS-02): the organisation reads the press and official bodies of many countries, sees one
// story across countries and publishers, and links it to the eight shares through the reviewed impact links.
//   node scripts/world-news.mjs list                          the catalogue and each source's state (read-only)
//   node scripts/world-news.mjs probe <id...>|--all           read a feed now with the organisation's strict reader; nothing is stored
//   node --env-file=.env scripts/world-news.mjs enable <id...> --yes
//                                                             owner: probe, register and approve the source, write .local/feed-<id>.json
//   node scripts/world-news.mjs coverage                      which feeds work, by country; a failing one names its backup
//   node scripts/world-news.mjs stories [--hours 48]          group the last hours' items into stories across countries, and keep
//                                                             every collected headline for the daily link study (chains.py study)
// What it never does: verify anything (stories are unverified press; evidence review is unchanged), trade, or enable a
// source on its own. The cycle collects enabled feeds as before; this command adds the catalogue, coverage and stories.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchFeed, validateFeedConfig } from '../integrations/publisher-feeds/feed-client.mjs';
import { FeedFormatError, LOCAL_ZONE, prepareFeed } from '../integrations/publisher-feeds/feed-parser.mjs';
import { classify } from '../backend/dist/src/evidence-triage.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CATALOGUE = join(ROOT, 'integrations', 'publisher-feeds', 'world-sources.json');
export const LINKS = join(ROOT, 'integrations', 'trading-desk', 'impact_links.json');
const COUNTRIES = new Set(['IN', 'US', 'CN', 'EU', 'GB', 'JP', 'WORLD']);
const STALE_MS = 3 * 86_400_000;

/** The catalogue, checked: unique ids, HTTPS feeds, a source id per entry, backups that exist. */
export async function loadCatalogue(path = CATALOGUE) {
  const { sources } = JSON.parse(await readFile(path, 'utf8'));
  const ids = new Set(sources.map(s => s.id));
  if (ids.size !== sources.length) throw new Error('Catalogue ids must be unique');
  for (const s of sources) {
    const ok = /^[a-z0-9-]{1,40}$/.test(s.id) && COUNTRIES.has(s.country) && [1, 2].includes(s.tier) && /^news-[a-z0-9-]{1,40}$/.test(s.sourceId)
      && new URL(s.feedUrl).protocol === 'https:' && new URL(s.origin).origin === s.origin && s.origin.startsWith('https://')
      && (s.backup === null || (ids.has(s.backup) && s.backup !== s.id)) && typeof s.name === 'string' && Array.isArray(s.topics)
      && (s.localZone === undefined || LOCAL_ZONE.test(String(s.localZone)));
    if (!ok) throw new Error(`Invalid catalogue entry ${s.id}`);
  }
  return sources;
}

/** The feed configuration the cycle reads (.local/feed-<id>.json). */
export const feedConfig = s => ({ enabled: true, feedUrl: s.feedUrl, kind: 'news', sources: [{ origin: s.origin, sourceId: s.sourceId }],
  maxItemsPerCycle: 25, pollIntervalMinutes: 60, timeoutMs: 15000, ...(s.localZone ? { localZone: s.localZone } : {}) });

/** Reads the feed once with the cycle's own client and parser. Nothing is stored or submitted. */
export async function probe(s, { transport = fetch, now = Date.now() } = {}) {
  const feed = validateFeedConfig(feedConfig(s));
  let fetched;
  try { fetched = await fetchFeed(feed, {}, { transport, now }); }
  catch (error) { return { id: s.id, ok: false, problem: error.code ?? 'FEED_FETCH_FAILED' }; }
  try {
    const prepared = prepareFeed(fetched.bytes, feed, now);
    const reasons = {};
    for (const r of prepared.rejected) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
    const newest = prepared.observations.map(o => o.publishedAt).sort().at(-1) ?? null;
    return { id: s.id, ok: prepared.observations.length > 0, accepted: prepared.observations.length, rejected: prepared.rejected.length, reasons, newest,
      ...(prepared.observations.length ? {} : { problem: 'no entry passed the reader' }) };
  } catch (error) {
    if (!(error instanceof FeedFormatError)) throw error;
    return { id: s.id, ok: false, problem: 'FEED_PARSE_ERROR: ' + error.message };
  }
}

/** Owner: only a source whose probe passes is registered, approved and given a feed configuration. */
export async function enable(ids, { env = process.env, root = ROOT, catalogue, transport = fetch, fetchImpl = fetch, now = Date.now() } = {}) {
  const sources = catalogue ?? await loadCatalogue();
  const owner = JSON.parse(env.PRINCIPALS_JSON || '[]').filter(p => p.role === 'owner');
  if (owner.length !== 1) throw new Error('Configure exactly one owner credential');
  const base = (env.API_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
  const out = [];
  for (const id of ids) {
    const s = sources.find(x => x.id === id);
    if (!s) { out.push({ id, state: 'unknown id' }); continue; }
    const check = await probe(s, { transport, now });
    if (!check.ok) { out.push({ id, state: 'not enabled', problem: check.problem, reasons: check.reasons }); continue; }
    const body = JSON.stringify({ id: s.sourceId, name: s.name, url: s.origin, approved: true });
    const r = await fetchImpl(base + '/v1/sources', { method: 'POST', body, redirect: 'error', headers: { Authorization: 'Bearer ' + owner[0].token,
      'Content-Type': 'application/json', 'Idempotency-Key': 'world-source-' + createHash('sha256').update(body).digest('hex').slice(0, 48) } });
    const text = await r.text();
    if (!r.ok && !/already exists/i.test(text)) { out.push({ id, state: 'not enabled', problem: `source registration refused (HTTP ${r.status})` }); continue; }
    const path = join(root, '.local', `feed-${s.id}.json`);
    await mkdir(join(root, '.local', 'feeds'), { recursive: true });
    if (!existsSync(path)) await writeFile(path, JSON.stringify(feedConfig(s), null, 2) + '\n');
    out.push({ id, state: 'enabled', accepted: check.accepted, newest: check.newest, source: s.sourceId });
  }
  return out;
}

async function enabledFeeds(root) {
  const dir = join(root, '.local');
  if (!existsSync(dir)) return new Set();
  const names = (await readdir(dir)).filter(n => /^feed-[a-z0-9-]+\.json$/.test(n));
  const on = new Set();
  for (const n of names) { try { if (JSON.parse(await readFile(join(dir, n), 'utf8')).enabled === true) on.add(n.slice(5, -5)); } catch { /* not a feed */ } }
  return on;
}

/** Per source: off, not-run, working, stale or failing (from the feed's own checkpoint); a broken one names its backup. */
export async function coverage({ root = ROOT, catalogue, now = Date.now() } = {}) {
  const sources = catalogue ?? await loadCatalogue();
  const on = await enabledFeeds(root);
  const rows = [];
  for (const s of sources) {
    let state = on.has(s.id) ? 'not-run' : 'off', detail = null;
    const cp = join(root, '.local', 'feeds', s.id, 'checkpoint.json');
    if (on.has(s.id) && existsSync(cp)) {
      try {
        const c = JSON.parse(await readFile(cp, 'utf8'));
        if (c.consecutiveFailures > 0) { state = 'failing'; detail = `${c.lastFailureCode ?? 'error'} ×${c.consecutiveFailures}`; }
        else if (c.lastSuccessAt) state = now - Date.parse(c.lastSuccessAt) > STALE_MS ? 'stale' : 'working';
        if (state === 'stale') detail = 'last read ' + c.lastSuccessAt.slice(0, 10);
      } catch { state = 'failing'; detail = 'unreadable checkpoint'; }
    }
    rows.push({ id: s.id, country: s.country, tier: s.tier, name: s.name, state, detail, backup: s.backup });
  }
  const advice = rows.filter(r => r.state === 'failing' || r.state === 'stale').map(r => {
    const b = r.backup && rows.find(x => x.id === r.backup);
    const fix = !b ? 'no backup listed; check the publisher' : b.state === 'off' ? `enable its backup: npm run world -- enable ${b.id} --yes`
      : `its backup ${b.id} is ${b.state}`;
    return `World news: ${r.name} is ${r.state} (${r.detail}); ${fix}`;
  });
  const countries = [...new Set(rows.filter(r => r.state === 'working').map(r => r.country))].sort();
  return { sources: rows, countriesCovered: countries, advice };
}

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'over', 'after', 'amid', 'says', 'said', 'will', 'its', 'are', 'was',
  'has', 'have', 'new', 'how', 'why', 'what', 'who', 'not', 'but', 'more', 'than', 'out', 'about', 'per', 'cent']);
export const tokens = title => new Set(title.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOP.has(w)));
const jaccard = (a, b) => { let n = 0; for (const w of a) if (b.has(w)) n++; return n / (a.size + b.size - n || 1); };
const matches = (text, keywords) => keywords.some(k => new RegExp('(?<![a-z0-9])' + k.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![a-z0-9])').test(text));

/** Items collected by the feed runs in the window, one per article link. */
export async function recentItems({ root = ROOT, hours = 48, now = Date.now() } = {}) {
  const feeds = join(root, '.local', 'feeds'), since = now - hours * 3_600_000, byUrl = new Map();
  if (!existsSync(feeds)) return [];
  for (const feed of await readdir(feeds)) {
    const runs = join(feeds, feed, 'runs');
    if (!existsSync(runs)) continue;
    for (const run of await readdir(runs)) {
      const path = join(runs, run, 'selection.json');
      if (!existsSync(path)) continue;
      let selection;
      try { selection = JSON.parse(await readFile(path, 'utf8')); } catch { continue; }
      for (const o of selection.observations ?? []) {
        if (Date.parse(o.publishedAt) >= since && Date.parse(o.publishedAt) <= now && !byUrl.has(o.url)) byUrl.set(o.url, o);
      }
    }
  }
  return [...byUrl.values()];
}

/**
 * One story = items whose titles share most of their words (or the same link), from any country or publisher.
 * Syndicated copies count once per publisher. Each story is linked to shares it names (direct) and to shares a
 * world or Indian driver reaches (inferred, labelled with the driver; a link says "may affect", never the direction).
 */
export function cluster(items, { catalogue = [], links = [], threshold = 0.5 } = {}) {
  const bySource = new Map(catalogue.map(s => [s.sourceId, s]));
  const sorted = [...items].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt) || a.url.localeCompare(b.url));
  const groups = [];
  for (const item of sorted) {
    const words = tokens(item.title);
    const home = groups.find(g => g.items.some(i => i.url === item.url) || g.words.some(w => words.size && jaccard(w, words) >= threshold));
    if (home) { home.items.push(item); home.words.push(words); } else groups.push({ items: [item], words: [words] });
  }
  return groups.map(g => {
    const meta = g.items.map(i => bySource.get(i.sourceId));
    const publishers = [...new Set(g.items.map((i, n) => meta[n]?.origin ?? new URL(i.url).origin))];
    const countries = [...new Set(meta.map(m => m?.country ?? '?'))].sort();
    const text = g.items.map(i => `${i.title}\n${i.content ?? ''}`).join('\n');
    const direct = classify(text).matched.filter(m => !m.includes(':'));
    const lower = text.toLowerCase();
    const drivers = links.filter(l => matches(lower, l.keywords)).map(l => ({ driver: l.driver, region: l.region ?? 'IN',
      shares: l.symbols.map(s => s.replace(/\.NS$/, '')).filter(s => !direct.includes(s)) }));
    return { title: g.items[0].title, firstSeen: g.items[0].publishedAt, lastSeen: g.items.at(-1).publishedAt, items: g.items.length,
      publishers: publishers.length, sources: [...new Set(meta.map((m, n) => m?.name ?? g.items[n].sourceId))], countries,
      crossBorder: countries.filter(c => c !== '?').length > 1, directShares: direct, drivers,
      links: g.items.slice(0, 3).map(i => i.url) };
  }).sort((a, b) => Number(b.directShares.length + b.drivers.length > 0) - Number(a.directShares.length + a.drivers.length > 0)
    || b.countries.length - a.countries.length || b.publishers - a.publishers || b.lastSeen.localeCompare(a.lastSeen));
}

/** Writes .local/world/stories-<day>.json and latest.json: the stories that reach the shares, then the rest. */
export async function stories({ root = ROOT, hours = 48, now = Date.now(), catalogue, links } = {}) {
  const items = await recentItems({ root, hours, now });
  const all = cluster(items, { catalogue: catalogue ?? await loadCatalogue(), links: links ?? JSON.parse(await readFile(LINKS, 'utf8')).links });
  const report = { generatedAt: new Date(now).toISOString(), windowHours: hours, items: items.length, stories: all.length,
    crossBorder: all.filter(s => s.crossBorder).length, reachingShares: all.filter(s => s.directShares.length || s.drivers.length).length,
    top: all.slice(0, 30), note: 'Unverified press, grouped by title similarity. Driver links are inferred. Not evidence and not a trading signal.' };
  const dir = join(root, '.local', 'world');
  await mkdir(dir, { recursive: true });
  for (const name of [`stories-${report.generatedAt.slice(0, 10)}.json`, 'latest.json']) await writeFile(join(dir, name), JSON.stringify(report, null, 2) + '\n');
  return report;
}

/**
 * Every item ever collected, in the desk's headline format, for chains.py study: the organisation tests its own
 * driver links (Indian and world) against the share moves that followed. Titles of unverified press are fine here: the
 * study measures whether a link is followed by larger moves, it never trades or treats a title as a fact.
 */
export async function headlineHistory({ root = ROOT, catalogue } = {}) {
  const names = new Map((catalogue ?? await loadCatalogue()).map(s => [s.sourceId, s.name]));
  const items = await recentItems({ root, hours: 24 * 3650, now: Date.now() });
  const rows = items.map(o => ({ publishedAt: o.publishedAt.replace(/(\.\d+)?Z$/, '+00:00'), source: (names.get(o.sourceId) ?? o.sourceId).slice(0, 80),
    title: o.title.slice(0, 240), symbols: classify(`${o.title}\n${o.content ?? ''}`).matched.filter(m => !m.includes(':')).map(s => s + '.NS') }))
    .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt) || a.title.localeCompare(b.title));
  const dir = join(root, '.local', 'world');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'headline-history.json'), JSON.stringify(rows) + '\n');
  return rows.length;
}

/** The latest link study (chains.py study): how many driver links carry information, show no effect, or need more events. */
export async function linkStudy(root = ROOT) {
  const path = join(root, '.local', 'trading-desk', 'chains', 'link-study.json');
  if (!existsSync(path)) return null;
  const report = JSON.parse(await readFile(path, 'utf8'));
  const verdicts = {};
  for (const r of Object.values(report.drivers)) verdicts[r.verdict] = (verdicts[r.verdict] ?? 0) + 1;
  const carrying = Object.entries(report.drivers).filter(([, r]) => r.verdict === 'link-carries-information').map(([d]) => d);
  return { headlines: report.headlines, drivers: Object.keys(report.drivers).length, verdicts, carrying };
}

/** The digest's world section: coverage (with advice), the latest stories and the link study; never throws. */
export async function worldSummary({ root = ROOT, now = Date.now() } = {}) {
  try {
    const cov = await coverage({ root, now });
    const path = join(root, '.local', 'world', 'latest.json');
    const latest = existsSync(path) ? JSON.parse(await readFile(path, 'utf8')) : null;
    const record = join(root, '.local', 'trading-desk', 'scenario', 'record.json');
    const scenario = existsSync(record) ? JSON.parse(await readFile(record, 'utf8')) : null;
    return { coverage: cov, stories: latest, links: await linkStudy(root), scenario };
  } catch (error) { return { error: error.message }; }
}

const describe = s => {
  const linked = s.drivers.filter(d => d.shares.length).map(d => `${d.driver} → ${d.shares.join(', ')}`);
  return `[${s.countries.join(', ')}] ${s.title} — ${s.publishers} publisher${s.publishers === 1 ? '' : 's'}`
    + (s.directShares.length ? `; names ${s.directShares.join(', ')}` : '') + (linked.length ? `; inferred: ${linked.join('; ')}` : '');
};
export { describe as describeStory };

async function main() {
  const args = process.argv.slice(2), [command = 'list', ...rest] = args.filter(a => !a.startsWith('--'));
  if (command === 'list' || command === 'coverage') {
    const c = await coverage();
    for (const r of c.sources) console.log(`${r.id.padEnd(18)} ${r.country.padEnd(6)} tier ${r.tier}  ${r.state.padEnd(8)} ${r.name}${r.detail ? ` (${r.detail})` : ''}`);
    console.log(`Countries with a working feed: ${c.countriesCovered.join(', ') || 'none yet'}`);
    for (const a of c.advice) console.log('! ' + a);
    return;
  }
  if (command === 'probe') {
    const catalogue = await loadCatalogue();
    const chosen = args.includes('--all') ? catalogue : catalogue.filter(s => rest.includes(s.id));
    if (!chosen.length) throw new Error('Name catalogue ids to probe, or --all');
    for (const s of chosen) console.log(JSON.stringify(await probe(s)));
    return;
  }
  if (command === 'enable') {
    if (!rest.length || !args.includes('--yes')) throw new Error('Usage: world-news.mjs enable <id...> --yes (owner; the backend must be running)');
    for (const r of await enable(rest)) console.log(JSON.stringify(r));
    console.log('Enabled feeds are collected by the next cycle (npm run cycle).');
    return;
  }
  if (command === 'stories') {
    const i = args.indexOf('--hours'), hours = i >= 0 ? Number(args[i + 1]) : 48;
    if (!Number.isInteger(hours) || hours < 1 || hours > 336) throw new Error('--hours must be 1–336');
    const r = await stories({ hours });
    const history = await headlineHistory();
    console.log(`${r.items} items → ${r.stories} stories (${r.crossBorder} across countries, ${r.reachingShares} reach the shares); ${history} headlines kept for the link study`);
    for (const s of r.top.slice(0, 10)) console.log('  ' + describe(s));
    console.log(JSON.stringify({ state: 'done', items: r.items, stories: r.stories, crossBorder: r.crossBorder, reachingShares: r.reachingShares }));
    return;
  }
  throw new Error('Usage: world-news.mjs list | probe <id...>|--all | enable <id...> --yes | coverage | stories [--hours N]');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
