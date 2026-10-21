// The owner's overview (OVERSIGHT-01): the whole organisation on one screen, read-only. The owner approves and oversees;
// this is the overseeing. It asks the backend with the owner credential and reads local files; it changes nothing.
//   npm run status
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { heartbeat, modelHealthUrl, nextRuns } from './supervisor.mjs';
import { worldSummary } from './world-news.mjs';
import { knowledgeSummary, marketRegime } from './daily-digest.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rupees = p => p === null || p === undefined ? 'n/a' : `Rs ${(Number(p) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const RULES = ['suspendOnRecommendation', 'acknowledgeWatch', 'raiseBudget', 'approveBirths', 'activateReleases', 'qualifyBots', 'startingBudgetPaise',
  'trialNewReleases', 'promoteCanaries', 'rollbackFailingReleases'];

/** What the desk's own files say, readable with the backend down: the market regime and the world news. */
function localLines(f) {
  const out = [];
  const research = f.knowledge?.live?.research;
  if (research) out.push(`Research  ${research.ideasTried} ideas on ${research.from}..${research.through}: ${research.passing.length ? 'passing ' + research.passing.join(', ') : 'none passes'}`
    + `; best ${research.best[0]?.name ?? '?'}${research.lowestRisk ? `; lowest risk ${research.lowestRisk.name} (worst fall ${research.lowestRisk.maxDrawdownPct}%)` : ''}`
    + `${f.knowledge.unknown?.length ? `; ${f.knowledge.unknown.length} unknown cycle problem(s)` : ''}`);
  if (f.intraday) out.push(`Intraday  ${f.intraday.mode} ${f.intraday.day}: basket ${f.intraday.final.basketMovePct}%, positions ${f.intraday.final.lossPct}%; `
    + `events: ${f.intraday.events.map(e => e.rule + ':' + e.subject).join(', ') || 'none'}`);
  if (f.regime) out.push(`Regime    ${f.regime.state && f.regime.state !== 'fresh' ? f.regime.state.toUpperCase() + ' ' : ''}${f.regime.risk} on ${f.regime.date} (${f.regime.distributionDays} distribution days; ${f.regime.breadth200d ?? '?'}/${f.regime.shares} above 200-day); advisory ceiling ${f.regime.exposureCeilingPct}%`);
  if (f.world && !f.world.error) {
    const w = f.world, s = w.stories;
    out.push(`World     feeds working in ${w.coverage.countriesCovered.join(', ') || 'no country yet'}`
      + (s ? `; last ${s.windowHours}h: ${s.stories} stories, ${s.crossBorder} across countries, ${s.reachingShares} reach the shares` : '')
      + (w.links ? `; links carrying information: ${w.links.carrying.join(', ') || 'none yet'} of ${w.links.drivers}` : ''));
  }
  return out;
}

/** Pure: facts in, the overview lines out. */
export function render(f) {
  const out = [`Nexus organisation, ${f.at.slice(0, 16).replace('T', ' ')} UTC (paper only)`, ''];
  out.push(`Backend   ${f.backend ? 'up' : 'DOWN (npm start)'}${f.digest?.halted ? '; NEW RISK HALTED' : ''}    Model ${f.model === null ? 'not configured' : f.model ? 'up' : 'down'}`);
  if (!f.backend) return [...out, '', 'Nothing more can be read from the backend while it is down.', ...localLines(f)];
  const p = f.autonomy?.policy;
  const on = p ? RULES.filter(r => p.rules[r] && p.rules[r] !== null) : [];
  out.push(`Autonomy  ${p ? `policy ${p.sequence} (set ${p.setAt.slice(0, 10)} by ${p.setBy}): ${on.join(', ') || 'nothing automatic'}` : 'no standing approvals: every decision waits for you (npm run autonomy)'}`);
  out.push(`Agenda    ${f.agenda?.waiting ?? 0} decision(s) waiting${f.agenda?.waiting ? ' (npm run agenda)' : ''}`, '');
  out.push('Members');
  for (const b of f.bots) {
    const perf = f.digest?.money?.byBot?.find(x => x.botId === b.id), bench = f.digest?.benchmark?.find(x => x.botId === b.id);
    const live = f.digest?.liveFitness?.find(x => x.botId === b.id);
    const parts = [b.state, b.suspended ? 'SUSPENDED' : null, b.release ? `release v${b.release.version} ${b.release.stage}` : 'no release (shadow)',
      perf ? `P&L ${rupees(perf.totalPaise)} (${perf.returnOnBudgetPct ?? 0}% of budget)` : null,
      bench?.excessPct !== null && bench?.excessPct !== undefined ? `${bench.excessPct >= 0 ? '+' : ''}${bench.excessPct} pts vs basket` : null,
      bench?.risk?.volatilityPct !== null && bench?.risk?.volatilityPct !== undefined ? `vol ${bench.risk.volatilityPct}%, VaR ${bench.risk.var95Pct}%` : null,
      live ? `live: ${live.verdict} (${live.right}/${live.judged})` : null].filter(Boolean);
    out.push(`  ${b.id.padEnd(16)} ${parts.join('; ')}`);
  }
  const m = f.digest?.money;
  if (m) out.push('', `Money     realised ${rupees(m.realisedPaise)}, open ${rupees(m.unrealisedPaise)}, total ${rupees(m.totalPaise)}${m.stalePositions ? `; ${m.stalePositions} stale price(s)` : ''}`);
  out.push(`Cycle     ${f.lastCycle ? `${f.lastCycle.day}: ${f.lastCycle.failed.length ? 'failed ' + f.lastCycle.failed.join(', ') : 'no failed steps'}` : 'none yet'}`);
  if (f.supervisor && f.supervisor.state !== 'never') out.push(`Supervisor ${f.supervisor.state === 'alive' ? `alive${f.supervisor.running ? `, running ${f.supervisor.running}` : ''}`
    : `NOT RUNNING (last heartbeat ${Math.round(f.supervisor.ageSeconds / 60)} min ago): npm run supervisor`}`);
  out.push(`Next      ${f.next.map(r => `${r.id} ${new Date(r.at + 330 * 60_000).toISOString().slice(5, 16).replace('T', ' ')} IST`).join('; ')}`);
  out.push(`R&D       ${f.ideas} invented idea(s) in the ledger${f.scout ? `; last screen ${f.scout.through}: ${f.scout.passing} passing of ${f.scout.ideasTried}` : ''}`);
  out.push(...localLines(f));
  if (f.tradingagents) out.push(`TradingAgents  last decided ${f.tradingagents.day}: ${Object.entries(f.tradingagents.ratings).map(([s, r]) => `${s} ${r ?? '?'}`).join(', ')}`);
  if (f.digest?.needsOwner?.length) out.push('', 'Needs you', ...f.digest.needsOwner.map(n => '  - ' + n));
  return out;
}

async function json(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } }

export async function gather(env = process.env, { fetchImpl = fetch, root = ROOT, now = Date.now() } = {}) {
  const base = (env.API_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
  const owner = JSON.parse(env.PRINCIPALS_JSON || '[]').find(p => p.role === 'owner')?.token;
  const ask = async (method, path, body) => {
    try {
      const r = await fetchImpl(base + path, { method, redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { 'Content-Type': 'application/json', ...(owner ? { Authorization: 'Bearer ' + owner } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  };
  const health = modelHealthUrl(env.HERMES_MODEL_BASE_URL);
  const model = health ? await fetchImpl(health, { signal: AbortSignal.timeout(3000) }).then(r => r.ok, () => false) : null;
  const backend = (await ask('GET', '/v1/health'))?.mode === 'paper';
  const facts = { at: new Date(now).toISOString(), backend, model, bots: [], next: nextRuns(now) };
  if (backend) {
    const [digest, bots, agenda, autonomy] = await Promise.all([ask('POST', '/v1/owner/digest', {}), ask('GET', '/v1/bots'), ask('GET', '/v1/organisation/agenda'), ask('GET', '/v1/autonomy')]);
    Object.assign(facts, { digest, agenda, autonomy });
    for (const b of (bots ?? []).filter(x => x.state !== 'retired')) {
      const view = await ask('POST', '/v1/releases/view', { botId: b.id });
      const current = view?.releases?.find(r => r.id === (view.active ?? view.canary));
      facts.bots.push({ id: b.id, state: b.state, suspended: (digest?.organisation?.suspendedBots ?? []).includes(b.id), release: current ? { version: current.version, stage: current.stage } : null });
    }
  }
  const cycles = join(root, '.local', 'cycles');
  const days = existsSync(cycles) ? (await readdir(cycles)).filter(n => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort() : [];
  const journal = days.length ? await json(join(cycles, days.at(-1))) : null;
  facts.lastCycle = journal ? { day: days.at(-1).slice(0, 10), failed: Object.entries(journal.steps ?? {}).filter(([, s]) => s.status === 'failed').map(([id]) => id) } : null;
  const ledger = join(root, '.local', 'trading-desk', 'rnd', 'ideas.jsonl');
  facts.ideas = existsSync(ledger) ? (await readFile(ledger, 'utf8')).split('\n').filter(l => l.trim()).length : 0;
  const rnd = join(root, '.local', 'trading-desk', 'rnd');
  const screens = existsSync(rnd) ? (await readdir(rnd)).filter(n => /^scout-\d{4}-\d{2}\.json$/.test(n)).sort() : [];
  const scout = screens.length ? await json(join(rnd, screens.at(-1))) : null;
  facts.scout = scout ? { through: scout.through, ideasTried: scout.ideasTried, passing: scout.candidates.filter(c => c.passes).length } : null;
  const decisions = join(root, '.local', 'tradingagents', 'decisions');
  const decided = existsSync(decisions) ? (await readdir(decisions)).filter(n => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort() : [];
  const ta = decided.length ? await json(join(decisions, decided.at(-1))) : null;
  facts.tradingagents = ta ? { day: ta.day, ratings: Object.fromEntries(Object.entries(ta.decisions).map(([s, d]) => [s, d.rating])) } : null;
  facts.world = await worldSummary({ root, now });
  facts.regime = await marketRegime(root);
  facts.knowledge = await knowledgeSummary(root, now);
  facts.intraday = await json(join(root, '.local', 'intraday', 'latest.json'));
  facts.supervisor = await heartbeat(root, now);
  if (facts.world?.coverage?.advice?.length && facts.digest) facts.digest.needsOwner = [...(facts.digest.needsOwner ?? []), ...facts.world.coverage.advice];
  return facts;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  gather().then(f => console.log(render(f).join('\n'))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
