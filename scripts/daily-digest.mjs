// Daily owner digest (OBS-01): fetch /v1/owner/digest with the evaluator credential, write a readable Markdown note to
// .local/digests/<day>.md, and, when ALERT_WEBHOOK_URL is set, post a short summary there too.
//   node --env-file=.env scripts/daily-digest.mjs
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { settings } from './deliver-alerts.mjs';
import { dataManifest } from './organisation-cycle.mjs';
import { diagnose } from './playbook.mjs';
import { describeStory, worldSummary } from './world-news.mjs';

const rupees = paise => {
  const n = Number(BigInt(paise)) / 100;
  return (n < 0 ? '−₹' : '₹') + Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
};

/** NEWS-02: the world section, from the feeds' coverage and the latest story groups (unverified press). */
export function worldLines(world) {
  if (!world || world.error) return world?.error ? ['## World news', `- Not available: ${world.error}`, ''] : [];
  const c = world.coverage, s = world.stories;
  const working = c.sources.filter(r => r.state === 'working').length, enabled = c.sources.filter(r => r.state !== 'off').length;
  return ['## World news (unverified press; links are inferred)',
    `- Feeds working: ${working} of ${enabled} enabled; countries covered: ${c.countriesCovered.join(', ') || 'none yet'}`,
    ...(s ? [`- Last ${s.windowHours} hours: ${s.items} items in ${s.stories} stories; ${s.crossBorder} across countries, ${s.reachingShares} reach the shares`,
      ...s.top.filter(x => x.directShares.length || x.drivers.length).slice(0, 8).map(x => `- ${describeStory(x)}`)]
      : ['- No stories grouped yet (cycle step world-stories).']),
    ...(world.links ? [`- Driver links tested on ${world.links.headlines} headlines: ${world.links.carrying.length} of ${world.links.drivers} carry information`
      + (world.links.carrying.length ? ` (${world.links.carrying.join(', ')})` : '') + `; ${world.links.verdicts['insufficient-evidence'] ?? 0} need more events`] : []),
    ...(world.scenario ? [`- Scenario panel (shadow): ${world.scenario.panel.right} right, ${world.scenario.panel.wrong} wrong after ${world.scenario.horizonSessions} sessions`
      + ` (${world.scenario.panel.verdict}); ${world.scenario.waiting} call(s) waiting`] : []), ''];
}

/** AWARE-01: the market pulse (press read by rules, NIFTY 500 prices): movers and why, big players, flows, sectors. */
export function pulseLines(p) {
  if (!p) return [];
  const pct = x => `${x >= 0 ? '+' : ''}${x}%`;
  const name = c => String(c).replace(/ (Ltd\.?|Limited)$/, '');
  const moves = p.movers.filter(m => !m.period).slice(0, 5)
    .map(m => `${name(m.company)} ${m.direction === 'up' ? '+' : '-'}${m.pct}%${m.why ? ` (${m.why.slice(0, 80)})` : ''}`);
  const players = p.bigPlayers.slice(0, 3).map(b => `${b.actors.join('/')} ${b.action}${b.companies.length ? ' ' + b.companies.map(name).join(', ') : ''}`
    + `${b.amountCrore ? ` Rs ${b.amountCrore.toLocaleString('en-IN')} cr` : ''}`);
  const flows = p.flows.slice(0, 3).map(f => `${f.actors.join('/')} ${f.action}${f.amountCrore ? ` Rs ${f.amountCrore.toLocaleString('en-IN')} cr` : ''}`);
  const m = p.market;
  const why = r => `${name(r.company)} ${pct(r.weekPct)}${r.why ? ` (${r.why.slice(0, 60)})` : ' (no news)'}`;
  return [`## Market pulse (press read by rules over ${p.windowDays} days${m ? `; NIFTY 500 prices to ${m.asOf}` : ''})`,
    `- In the press: ${p.counts.up} shares reported up, ${p.counts.down} down${moves.length ? ': ' + moves.join('; ') : ''}`,
    ...(players.length ? [`- Big players: ${players.join('; ')}`] : []),
    ...(flows.length ? [`- Flows: ${flows.join('; ')}`] : []),
    ...(m ? [`- Sectors this month: best ${m.sectors.slice(0, 3).map(t => `${t.sector} ${pct(t.monthPct)}`).join(', ')}; `
      + `worst ${m.sectors.slice(-3).map(t => `${t.sector} ${pct(t.monthPct)}`).join(', ')}; ${m.breadthAbove200Pct}% of shares above their 200-day average`,
    `- The week's risers: ${m.risers.slice(0, 3).map(why).join('; ')}`,
    `- The week's fallers: ${m.fallers.slice(0, 3).map(why).join('; ')}`] : []),
    ...p.deskMoves.filter(d => d.unexplained).map(d => `- UNEXPLAINED: ${d.symbol} ${pct(d.vsBasketPct)} against the basket on ${d.date} (${d.sigmas} of its usual swings), no news`),
    ''];
}

/** MODEL-SPEED-01 / MODEL-UPGRADE-01: this machine's model settings and which model makes decisions. */
export function modelLines(tuning, routing, exams = null) {
  if (!tuning && !routing && !exams) return [];
  const d = routing?.decision;
  return ['## Models',
    `- ${tuning ? `Measured ${String(tuning.measuredAt).slice(0, 10)}: ${tuning.runtime === 'vulkan' ? 'graphics (Vulkan)' : 'CPU'}, ${tuning.threads} threads `
      + `(${tuning.threadsBatch} for prompts), about ${tuning.secondsPerCall}s a typical call` : 'Not tuned: npm run model:tune'}`,
    `- Decisions (debate, TradingAgents): ${d ? `${d.alias}, exams ${d.examOverall} on ${String(d.decidedAt).slice(0, 10)}` : 'the same model as the bulk work'}`,
    // MODEL-EXAMS-01: the cycle's latest re-examination after something changed
    ...(exams ? [`- Exams (${(exams.tasks ?? []).join(', ')}): ${exams.overall} on ${String(exams.at).slice(0, 10)}, ${exams.model}`
      + `${exams.overall !== 'SHIP' ? ` — ${Object.entries(exams.verdicts ?? {}).filter(([, v]) => v !== 'SHIP').map(([t]) => t).join(', ')} failed: see .local/model-eval/${exams.runId}/report.json` : ''}`] : []), ''];
}

/** REGIME-01: the latest market regime and its study, from the desk's files; null when the cycle has not made them. */
export async function marketRegime(root = join(dirname(fileURLToPath(import.meta.url)), '..')) {
  const read = async name => { try { return JSON.parse(await readFile(join(root, '.local', 'trading-desk', 'regime', name), 'utf8')); } catch { return null; } };
  const latest = await read('latest.json');
  if (!latest) return null;
  // an old or partial regime is labelled as such, never shown as today's (same rule as live_knowledge.regime_state)
  const age = (Date.now() - Date.parse(latest.date + 'T00:00:00Z')) / 86_400_000;
  const state = latest.inputsComplete === false ? 'incomplete' : age > 5 ? 'stale' : 'fresh';
  return { ...latest, state, study: await read('study.json') };
}

/** KNOW-05: the live knowledge (.local/trading-desk/knowledge/live.json) and failures the playbook does not know yet. */
export async function knowledgeSummary(root = join(dirname(fileURLToPath(import.meta.url)), '..'), now = Date.now()) {
  let live = null, unknown = [];
  try { live = JSON.parse(await readFile(join(root, '.local', 'trading-desk', 'knowledge', 'live.json'), 'utf8')); } catch { /* not made yet */ }
  try {
    unknown = (await readFile(join(root, '.local', 'cycles', 'unknown-problems.jsonl'), 'utf8')).split('\n').filter(l => l.trim()).map(l => JSON.parse(l))
      .filter(u => now - Date.parse(u.at) < 7 * 86_400_000)
      // re-read with today's playbook: a failure it has since learned is no longer "unknown" (27 Oct's model timeouts
      // were learned the same evening, yet kept showing as unknown for a week)
      .filter(u => diagnose(u.step, String(u.text ?? '')).id === 'unknown');
  } catch { /* none */ }
  let drafts = 0, review = null;
  try { drafts = JSON.parse(await readFile(join(root, '.local', 'trading-desk', 'knowledge', 'playbook-drafts.json'), 'utf8')).drafts.length; } catch { /* none */ }
  try { review = JSON.parse(await readFile(join(root, '.local', 'trading-desk', 'review-scorecard.json'), 'utf8')); } catch { /* not made yet */ }
  let pulse = null, tuning = null, routing = null;
  try { pulse = JSON.parse(await readFile(join(root, '.local', 'world', 'market-pulse.json'), 'utf8')); } catch { /* not made yet */ }
  try { tuning = JSON.parse(await readFile(join(root, '.local', 'models', 'tuning.json'), 'utf8')); } catch { /* not measured */ }
  try { routing = JSON.parse(await readFile(join(root, '.local', 'models', 'routing.json'), 'utf8')); } catch { /* no decision model */ }
  let exams = null;
  try { exams = JSON.parse(await readFile(join(root, '.local', 'model-eval', 'auto-last.json'), 'utf8')); } catch { /* not examined yet */ }
  let rndForward = null;  // RND-04: R&D ideas judged on months after registration
  try { rndForward = JSON.parse(await readFile(join(root, '.local', 'trading-desk', 'rnd', 'forward', 'reports', 'latest.json'), 'utf8')); } catch { /* none yet */ }
  const events = await upcomingEvents(root, now);
  return live || unknown.length || drafts || review || events || pulse || tuning || routing || exams || rndForward
    ? { live, unknown, drafts, review, events, pulse, tuning, routing, exams, rndForward } : null;
}

/** NEWS-05: the owner's events calendar (.local/events.json), the next `days` days; null when there is no calendar.
 *  NEWS-07: plus the desk shares' results days the press reported (.local/world/results-calendar.json), unless the
 *  owner lists results for that share within 20 days. */
export async function upcomingEvents(root = join(dirname(fileURLToPath(import.meta.url)), '..'), now = Date.now(), days = 7) {
  let raw = null, press = null;
  try { raw = JSON.parse(await readFile(join(root, '.local', 'events.json'), 'utf8')).events; } catch { /* no owner calendar */ }
  try { press = JSON.parse(await readFile(join(root, '.local', 'world', 'results-calendar.json'), 'utf8')).events; } catch { /* none yet */ }
  if (raw === null && press === null) return null;
  const owner = Array.isArray(raw) ? raw : [];
  const POLICY = ['rbi-policy', 'fomc'];
  // the owner's entry wins over the press's for the same share's results, or the same decider's policy day
  const key = e => (e.kind === 'results' ? String(e.symbols?.[0]).replace(/\.NS$/, '') : e.kind);
  const owned = owner.filter(e => (e?.kind === 'results' && e.symbols?.length === 1) || POLICY.includes(e?.kind));
  const near = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) <= 20 * 86_400_000;
  const reported = (Array.isArray(press) ? press : []).filter(e => e?.desk || POLICY.includes(e?.kind))
    .map(e => (POLICY.includes(e.kind) ? { date: e.date, kind: e.kind, title: `${e.company} (press report, not the official calendar)` }
      : { date: e.date, kind: 'results', symbols: [String(e.symbol).replace(/\.NS$/, '')], title: `${e.company} results (press report, not the exchange filing)` }))
    .filter(e => !owned.some(o => key(o) === key(e) && near(o.date, e.date)));
  const today = new Date(now + 330 * 60_000).toISOString().slice(0, 10), end = new Date(now + 330 * 60_000 + days * 86_400_000).toISOString().slice(0, 10);
  return [...owner, ...reported].filter(e => e && /^\d{4}-\d{2}-\d{2}$/.test(String(e.date)) && e.date >= today && e.date <= end && e.title)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export function eventLines(events) {
  if (events === null || events === undefined) return [];
  return ['## Coming up (next 7 days, from your events calendar and press-reported results and policy days)',
    ...(events.length ? events.map(e => `- ${e.date} ${String(e.kind ?? 'other')}: ${String(e.title).slice(0, 120)}${e.symbols?.length ? ` (${e.symbols.join(', ')})` : ''}`)
      : ['- Nothing scheduled in the calendar.']), ''];
}

/** TRUST-02: how the calls the risk review took and turned down went (the backend's own scores). */
export function reviewLines(card) {
  if (!card?.calls) return [];
  const pct = t => (t.rightPct === null ? 'none scored' : `${t.right} of ${t.scored} right (${t.rightPct}%)`);
  const reasons = Object.entries(card.byRejectionReason ?? {}).slice(0, 3).map(([r, t]) => `${r} ${t.right}/${t.scored}`);
  const regimes = Object.entries(card.byRegimeAtCall ?? {}).map(([r, t]) => `${r} ${t.right}/${t.scored}`);
  return ['## Review scorecard (scored calls)',
    `- Taken: ${pct(card.accepted)}; turned down: ${pct(card.rejected)} — ${card.verdict}`,
    ...(reasons.length ? [`- Turned down, by reason (right/scored): ${reasons.join(', ')}`] : []),
    ...(regimes.length ? [`- By the regime when the call was made: ${regimes.join(', ')}`] : []),
    ...(card.accepted?.buysWithPath ? [`- Buys taken, while held: average worst ${card.accepted.averageWorstPct}%, average best ${card.accepted.averageBestPct}%, `
      + `deepest ${card.accepted.worstPct}% (${card.accepted.buysWithPath} buys)`] : []), ''];
}

const PRICES_STALE_DAYS = 5, KNOWLEDGE_STALE_DAYS = 2;
const ageDays = (iso, now) => (iso ? (now - Date.parse(iso.length === 10 ? iso + 'T00:00:00Z' : iso)) / 86_400_000 : null);

/** TRUST-01: what today's digest rests on — today's cycle journal, the prices, the knowledge files and the code each
 *  run used (the run manifests) — so the owner can see whether to trust it. Read-only. */
export async function trustCheck(root = join(dirname(fileURLToPath(import.meta.url)), '..'), now = Date.now(), prices = dataManifest) {
  const read = async p => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; } };
  const cycles = join(root, '.local', 'cycles'), day = new Date(now).toISOString().slice(0, 10);
  let journals = [];
  try { journals = (await readdir(cycles)).filter(n => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort(); } catch { /* no cycle yet */ }
  const today = journals.includes(day + '.json') ? await read(join(cycles, day + '.json')) : null;
  const runs = [], crashed = [];
  for (const name of journals.slice(-2)) {
    const all = (await read(join(cycles, name)))?.runs ?? [];
    runs.push(...all.filter(r => r.code));
    // a run that never finished crashed or was killed (the newest one may be this very cycle, still running)
    crashed.push(...all.filter(r => !r.finishedAt && r.startedAt).map(r => r.startedAt));
  }
  if (crashed.at(-1) === runs.at(-1)?.startedAt) crashed.pop();
  const [before, latest] = runs.slice(-2).length === 2 ? runs.slice(-2) : [null, runs.at(-1) ?? null];
  const steps = Object.entries(today?.steps ?? {});
  const p = await prices({ root }).catch(() => null);
  return {
    day, crashedRuns: crashed,
    cycle: today ? { failed: steps.filter(([, s]) => s.status === 'failed').map(([id]) => id), degraded: steps.filter(([, s]) => s.status === 'degraded').map(([id]) => id),
      done: steps.filter(([, s]) => s.status === 'done').length } : null,
    prices: p ? { newest: p.newestLastSession, ageDays: ageDays(p.newestLastSession, now), behind: Object.entries(p.prices).filter(([, s]) => s.lastSession && s.lastSession < p.newestLastSession).map(([sym]) => sym) } : null,
    liveAgeDays: ageDays((await read(join(root, '.local', 'trading-desk', 'knowledge', 'live.json')))?.generatedAt, now),
    indexAgeDays: ageDays((await read(join(root, '.local', 'knowledge', 'index-meta.json')))?.builtAt, now),
    code: latest ? { commit: latest.code.commit, fingerprint: latest.code.fingerprint,
      changedFrom: before && before.code.fingerprint !== latest.code.fingerprint ? before.code.commit ?? before.code.fingerprint : null } : null,
  };
}

// TRUST-03: the limit settings, by the name the backend reads them from (values are limits, not secrets)
export const LIMIT_SETTINGS = { MAX_ORDER_PAISE: 'maxOrderPaise', MAX_EXPOSURE_PAISE: 'maxExposurePaise', MAX_REALISED_LOSS_PAISE: 'maxRealisedLossPaise',
  PAPER_FEE_BPS: 'feeBps', PAPER_SLIPPAGE_BPS: 'slippageBps', PAPER_COST_MODEL: 'costModel' };

/** Settings in this script's environment that differ from what the running backend loaded: a stale shell variable or a
 *  backend not restarted after a change. Only names are reported. */
export function limitMismatches(limits, env = {}) {
  if (!limits) return [];
  return Object.entries(LIMIT_SETTINGS).filter(([name, field]) => env[name] !== undefined && String(env[name]).trim() !== String(limits[field])).map(([name]) => name);
}

export function limitsLine(l) {
  if (!l) return null;
  return `Max order ${rupees(l.maxOrderPaise)} · organisation exposure ${rupees(l.maxExposurePaise)} · realised-loss limit ${rupees(l.maxRealisedLossPaise)}`
    + ` (${rupees(l.realisedLossPaise)} used${l.lossLimitUsedPct !== null ? `, ${l.lossLimitUsedPct}%` : ''}) · `
    + (l.costModel === 'nse-delivery' ? 'charges: NSE delivery (STT, stamp duty, exchange, GST, Rs 15.93 DP per sale)' : `fees ${l.feeBps} bps`)
    + `, slippage ${l.slippageBps} bps`;
}

/** The digest's own arithmetic: figures that must agree with each other (paise as integers, shares of one). */
export function arithmeticProblems(d) {
  const m = d.money, t = d.trading, out = [];
  try {
    if (BigInt(m.totalPaise) !== BigInt(m.realisedPaise) + BigInt(m.unrealisedPaise)) out.push('total P&L is not realised plus open');
  } catch { out.push('P&L figures are not whole paise'); }
  if (t.accuracy !== null && t.accuracy !== undefined && !(t.accuracy >= 0 && t.accuracy <= 1)) out.push(`accuracy ${t.accuracy} is outside 0..1`);
  if (['proposed', 'accepted', 'rejected', 'executed', 'scored'].some(k => !Number.isInteger(t[k]) || t[k] < 0)) out.push('a trading count is not a whole number');
  return out;
}

export function trustLines(t, regime = null, d = null) {
  if (!t) return [];
  const stale = d ? limitMismatches(d.limits, t.env) : [];
  const problems = [
    ...(d ? arithmeticProblems(d).map(x => `the digest does not add up: ${x}`) : []),
    ...(stale.length ? [`the running backend loaded different limits from this digest's settings (${stale.join(', ')}): restart the backend after a change, `
      + 'and clear stale shell variables'] : []),
    ...(t.crashedRuns?.length ? [`${t.crashedRuns.length} cycle run(s) never finished (started ${t.crashedRuns.join(', ')}): they crashed or were stopped`] : []),
    ...(!t.cycle ? [`no organisation cycle has run today (${t.day})`] : []),
    ...(t.cycle?.failed.length ? [`cycle steps failed: ${t.cycle.failed.join(', ')}`] : []),
    ...(t.cycle?.degraded.length ? [`cycle steps degraded: ${t.cycle.degraded.join(', ')}`] : []),
    ...(!t.prices?.newest ? ['no price data found'] : t.prices.ageDays > PRICES_STALE_DAYS ? [`prices are stale: last session ${t.prices.newest}`] : []),
    ...(t.prices?.behind.length ? [`prices behind the others for ${t.prices.behind.join(', ')}`] : []),
    ...(regime && regime.state !== 'fresh' ? [`the market regime is ${regime.state}`] : []),
    ...(t.liveAgeDays === null ? ['no live knowledge yet'] : t.liveAgeDays > KNOWLEDGE_STALE_DAYS ? [`live knowledge is ${Math.floor(t.liveAgeDays)} days old`] : []),
    ...(t.indexAgeDays === null ? ['no knowledge index yet'] : t.indexAgeDays > KNOWLEDGE_STALE_DAYS ? [`the knowledge index is ${Math.floor(t.indexAgeDays)} days old`] : []),
  ];
  return ['## Can you trust this digest?',
    ...(problems.length ? problems.map(x => `- Check first: ${x}`)
      : [`- Yes: today's cycle has ${t.cycle.done} step(s) done and none failed; prices to ${t.prices.newest}; knowledge rebuilt within ${KNOWLEDGE_STALE_DAYS} days.`]),
    ...(d?.limits ? [`- Limits the backend loaded: ${limitsLine(d.limits)}`] : []),
    ...(t.code ? [`- Code: commit ${t.code.commit ?? 'unknown'} (fingerprint ${t.code.fingerprint})`
      + (t.code.changedFrom ? `; changed since the previous run (${t.code.changedFrom}), so results before and after come from different code` : '')] : []), ''];
}

export function researchLines(k) {
  if (!k?.live?.research) return [];
  const r = k.live.research, wf = r.walkForward, safe = r.lowestRisk;
  return ['## Research (seen history, net of costs)',
    `- ${r.ideasTried} ideas tried on ${r.from}..${r.through}; passing: ${r.passing.join(', ') || 'none'} (bar ${r.bar})`,
    ...r.best.slice(0, 2).map(b => `- ${b.name}: ${b.ahead}/${b.behind} months vs the basket, ${b.averageExcessPct}% a month, beats ${b.beatsRandomPct ?? '?'}% of random pickers`),
    ...(safe ? [`- Lowest risk: ${safe.name}, worst fall ${safe.maxDrawdownPct}% (basket ${r.basket.maxDrawdownPct}%), Sharpe ${safe.sharpe} (basket ${r.basket.sharpe})`] : []),
    ...(wf ? [`- Choosing the best past idea each year (walk-forward): ${wf.ahead}/${wf.behind} months, ${wf.averageExcessPct}% a month`] : []),
    ...(r.bestAfterTax && r.basket?.afterTaxCagrPct !== undefined ? [`- After an approximate capital-gains tax: best idea ${r.bestAfterTax.name} `
      + `${r.bestAfterTax.afterTaxCagrPct}% a year, holding the basket ${r.basket.afterTaxCagrPct}% a year`] : []),
    ...forwardLines(k.rndForward), ''];
}

/** RND-04: the R&D forward tests, judged only on months after registration. */
export function forwardLines(f) {
  if (!f?.tests?.length) return [];
  const live = f.tests.filter(t => t.status === 'waiting' || t.status === 'running');
  const show = t => `${t.idea} ${t.status === 'waiting' ? `from ${t.firstMonth}` : `${t.monthsJudged}/${t.monthsNeeded} months, ${t.averageExcessPct}% a month, t ${t.tStat ?? '?'}`}`;
  return [`- Forward tests (months after registration only): ${live.length} of ${f.maxLive} running`
    + (live.length ? ` (${live.map(show).join('; ')})` : '') + (f.passed?.length ? `; PASSED: ${f.passed.join(', ')} (eligible for a birth proposal on your agenda)` : '')];
}

export function regimeLine(r) {
  if (!r) return null;
  const s = r.study, severe = s?.levels?.SEVERE, normal = s?.levels?.NORMAL;
  return `${r.state && r.state !== 'fresh' ? `${r.state.toUpperCase()} (do not rely on it): ` : ''}${r.risk} on ${r.date}: ${r.distributionDays} distribution day(s) in 25 sessions; ${r.breadth50d ?? '?'}/${r.shares} shares above their 50-day `
    + `and ${r.breadth200d ?? '?'}/${r.shares} above their 200-day average; basket ${r.aboveTrend200d === false ? 'below' : r.aboveTrend200d ? 'above' : '?'} its 200-day trend. `
    + `Advisory exposure ceiling ${r.exposureCeilingPct}% (not applied to any limit)`
    + (s ? `. On our history: ${s.verdict}; falls over 5% within ${s.horizonSessions} sessions followed ${Math.round(100 * (severe?.fallOver5PctShare ?? 0))}% of SEVERE days and ${Math.round(100 * (normal?.fallOver5PctShare ?? 0))}% of NORMAL days` : '');
}

export function render(d, world = null, regime = null, known = null, trust = null) {
  const t = d.trading, k = d.knowledge, m = d.money;
  const unknown = known?.unknown ?? [];
  const needs = [...d.needsOwner, ...(world?.coverage?.advice ?? []),
    ...(unknown.length ? [`${unknown.length} cycle failure(s) the problem playbook does not know (${[...new Set(unknown.map(u => u.step))].join(', ')}): `
      + 'find the cause and add an entry to integrations/trading-desk/knowledge/problems.json (log: .local/cycles/unknown-problems.jsonl)'] : []),
    ...(known?.drafts ? [`${known.drafts} playbook entr${known.drafts === 1 ? 'y' : 'ies'} drafted by the agents, waiting for you: `
      + 'playbook_drafts.py list, then accept <id> --yes'] : [])];
  const lines = [
    `# Organisation digest — ${d.generatedAt.slice(0, 10)}`, '',
    `Window: last ${d.windowHours} hours · mode: ${d.mode}${d.halted ? ' · **NEW RISK HALTED**' : ''}`, '',
    '## Needs you',
    ...(needs.length ? needs.map(n => `- ${n}`) : ['- Nothing right now.']), '',
    ...trustLines(trust, regime, d),
    '## Money (paper)',
    `- Total P&L ${rupees(m.totalPaise)} (realised ${rupees(m.realisedPaise)}, open ${rupees(m.unrealisedPaise)}); realised in window ${rupees(m.realisedInWindowPaise)}`,
    ...m.byBot.map(b => `- ${b.botId}: ${rupees(b.totalPaise)}${b.returnOnBudgetPct !== null ? ` (${b.returnOnBudgetPct}% of budget)` : ''}`),
    ...(m.stalePositions ? [`- ${m.stalePositions} open position(s) without a recent verified price: their value is unreliable`] : []), '',
    ...(regime ? ['## Market regime (advice)', `- ${regimeLine(regime)}`, ''] : []),
    ...eventLines(known?.events),
    '## Trading',
    `- ${t.proposed} proposed, ${t.accepted} accepted, ${t.rejected} rejected, ${t.executed} executed, ${t.challenges} challenges`,
    `- ${t.scored} outcomes scored${t.accuracy !== null ? `, ${Math.round(t.accuracy * 100)}% right` : ''}`,
    ...(t.lapsed ? [`- ${t.lapsed} accepted proposal(s) expired unexecuted; ${rupees(t.releasedPaise ?? '0')} of reservations released`] : []),
    ...(t.refusedOrders ? [`- ${t.refusedOrders} order(s) refused: ${(t.topRefusals ?? []).map(r => `${r.message} ×${r.count}`).join('; ')}`] : []),
    ...(t.corporateActions ? [`- ${t.corporateActions} corporate action(s) recorded; positions rescaled`] : []), '',
    '## Against holding all shares equally (same days)',
    ...((d.benchmark ?? []).length ? d.benchmark.map(b => b.excessPct === null ? `- ${b.botId}: no basket prices for ${b.from}..${b.to} yet`
      : `- ${b.botId} ${b.from}..${b.to}: ${b.returnPct > 0 ? '+' : ''}${Number(b.returnPct.toFixed(2))}% vs basket ${b.basketReturnPct > 0 ? '+' : ''}${b.basketReturnPct}%`
        + ` — ${b.excessPct > 0 ? 'ahead' : b.excessPct < 0 ? 'behind' : 'level'} by ${Math.abs(b.excessPct)} points`
        + (b.firstSnapshot ? ` (from the first day with basket prices; its record starts ${b.firstSnapshot})` : '')
        + (b.risk?.volatilityPct !== null && b.risk?.volatilityPct !== undefined
          ? `; risk: volatility ${b.risk.volatilityPct}% a year, Sharpe ${b.risk.sharpe ?? 'n/a'}, 1-day 95% VaR ${b.risk.var95Pct}%, worst fall ${b.risk.maxDrawdownPct}%` : ''))
      : ['- No bot has two daily snapshots yet.']), '',
    '## Organisation',
    `- Suspended bots: ${(d.organisation?.suspendedBots ?? []).join(', ') || 'none'}`,
    ...(d.organisation ? [`- Departments: ${d.organisation.departmentsActive} active, ${d.organisation.departmentsClosed} closed; `
      + `hackathons: ${d.organisation.hackathonsOpen} open, ${d.organisation.hackathonsJudging} being judged`] : []),
    ...(d.organisation?.automaticDecisions ? [`- Decisions the agents carried out under your standing approvals: ${d.organisation.automaticDecisions} (npm run autonomy)`] : []),
    ...(d.protections ? [d.protections.policySet
      ? `- Loss brakes: ${d.protections.paused.length ? d.protections.paused.map(b => `${b.botId} paused (${b.pauses.map(x => x.code.replace(/^protection-/, '')
        + (x.until ? ` until ${x.until.slice(0, 16).replace('T', ' ')} UTC` : '')).join(', ')})`).join('; ') + '; new buys only, each lifts by itself' : 'set; nothing paused'}`
      : '- Loss brakes: not set, so losses never pause a bot (founderReview B3; npm run protections)'] : []), '',
    '## Live fitness (paper calls on new days)',
    ...((d.liveFitness ?? []).length ? d.liveFitness.map(f => `- ${f.botId} (${f.scope}): ${f.verdict}, ${f.right} of ${f.judged} right`)
      : ['- No bot has scored live calls yet.']), '',
    ...reviewLines(known?.review),
    '## Knowledge',
    `- ${k.received} items received, ${k.verified} verified, ${k.rejected} rejected; ${k.backlog} waiting for review`
      + (k.setAside ? ` (${k.setAside} more set aside as out of scope)` : ''), '',
    ...worldLines(world),
    ...pulseLines(known?.pulse),
    ...modelLines(known?.tuning, known?.routing, known?.exams),
    ...researchLines(known),
    '## Bots (90-day scored accuracy, 5+ calls)',
    ...(d.bots.best.length ? d.bots.best.map(b => `- best: ${b.botId} ${Math.round(b.accuracy * 100)}% of ${b.scored}`) : ['- No bot has 5 scored calls yet.']),
    ...d.bots.weakest.map(b => `- weakest: ${b.botId} ${Math.round(b.accuracy * 100)}% of ${b.scored}`), '',
    `Alerts open: ${Object.entries(d.alerts).map(([s, n]) => `${n} ${s}`).join(', ') || 'none'} · model tokens: ${d.compute.tokens}`, '',
    `_${d.note}_`, ''];
  return lines.join('\n');
}

export async function run(env = process.env, { fetchImpl = fetch, outDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.local', 'digests'),
  world = worldSummary, regime = marketRegime, knowledge = knowledgeSummary, trust = trustCheck } = {}) {
  const s = settings(env);
  const response = await fetchImpl(s.base + '/v1/owner/digest', { method: 'POST', redirect: 'error', body: '{}',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.token } });
  if (!response.ok) throw new Error(`digest refused (HTTP ${response.status})`);
  const digest = await response.json();
  const text = render(digest, world ? await world() : null, regime ? await regime() : null, knowledge ? await knowledge() : null,
    trust ? { ...await trust(), env: Object.fromEntries(Object.keys(LIMIT_SETTINGS).filter(k => env[k] !== undefined).map(k => [k, env[k]])) } : null);
  await mkdir(outDir, { recursive: true });
  const path = join(outDir, digest.generatedAt.slice(0, 10) + '.md');
  await writeFile(path, text);
  let webhook = false;
  if (s.webhook) {
    const summary = `Digest ${digest.generatedAt.slice(0, 10)}: P&L ${rupees(digest.money.totalPaise)}; ${digest.trading.proposed} proposals, ` +
      `${digest.trading.executed} executed; ${digest.needsOwner.length} item(s) need you.`;
    const r = await fetchImpl(s.webhook, { method: 'POST', redirect: 'error', body: JSON.stringify({ message: summary }),
      headers: { 'Content-Type': 'application/json', Title: 'Organisation digest' }, signal: AbortSignal.timeout(10_000) });
    webhook = r.ok;
  }
  return { path, needsOwner: digest.needsOwner.length, webhook };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().then(r => console.log(JSON.stringify(r))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
