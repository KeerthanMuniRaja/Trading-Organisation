// The public results page (owner's choice, 9 Oct 2026; rebuilt 29 Oct for the organisation as it is now). It shows
// results and analysis only: never licensed prices, publishers' headlines, the organisation's internal records,
// credentials, local paths or the project's name (integrations/trading-desk/README.md, docs/data-export.md).
//   npm run results-page                 build .local/trading-desk/results-page.html (reads the backend if it runs)
//   npm run results-page -- --publish    build, check for anything private, then commit and push it to the public
//                                        trading-desk-results repository (index.html); the owner asks for this
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const L = (...p) => join(ROOT, '.local', ...p);
const PUBLIC_REPO = 'https://github.com/KeerthanMuniRaja/trading-desk-results.git';
export const README = `# Trading desk results

Paper-trading results and research of a team of AI agents on eight large NSE shares: live paper books against simply
holding all eight, ten years of research on the eight shares, the signals that carry information across the NIFTY 500,
the market's state, and the trading lessons the models are taught after checking them on the data.

**View the results:** https://keerthanmuniraja.github.io/trading-desk-results/

Research only: no money, no real orders. Paper results count new days only; research on past data screens ideas and
cannot prove them. Nothing here is advice.
`;
const read = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const rupees = paise => { const n = Number(BigInt(paise ?? 0)) / 100; return `${n < 0 ? '−' : ''}₹${Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; };
const pct = (v, d = 2) => v === null || v === undefined ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Number(v)).toFixed(d)}%`;
const num = (v, d = 2) => v === null || v === undefined ? '—' : Number(v).toFixed(d);

/** Everything the page shows, from the analyses the organisation already computes (no model, no network). */
export function gather(live = null) {
  const scoutFile = existsSync(L('trading-desk', 'rnd')) ? readdirNames(L('trading-desk', 'rnd')).filter(n => /^scout-\d{4}-\d{2}\.json$/.test(n)).sort().at(-1) : null;
  const labFile = existsSync(L('trading-desk', 'rnd')) ? readdirNames(L('trading-desk', 'rnd')).filter(n => /^factor-lab-\d{4}-\d{2}\.json$/.test(n)).sort().at(-1) : null;
  const regimeFile = existsSync(L('trading-desk', 'regime')) ? readdirNames(L('trading-desk', 'regime')).filter(n => /^regime-\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort().at(-1) : null;
  return { live, scout: scoutFile ? read(L('trading-desk', 'rnd', scoutFile)) : null, lab: labFile ? read(L('trading-desk', 'rnd', labFile)) : null,
    regime: regimeFile ? read(L('trading-desk', 'regime', regimeFile)) : null, regimeStudy: read(L('trading-desk', 'regime', 'study.json')),
    mentor: read(L('trading-desk', 'knowledge', 'mentor.json')), rndForward: read(L('trading-desk', 'rnd', 'forward', 'reports', 'latest.json')),
    world: read(L('world', 'latest.json')), tuning: read(L('models', 'tuning.json')), exams: read(L('model-eval', 'auto-last.json')) };
}
function readdirNames(dir) { try { return readdirSync(dir); } catch { return []; } }

function liveSection(live) {
  if (!live) return '<p class="muted">The live paper books are read from the running organisation; they were not available when this page was built.</p>';
  const bench = new Map((live.benchmark ?? []).map(b => [b.botId, b]));
  const rows = (live.money?.byBot ?? []).map(b => {
    const k = bench.get(b.botId);
    return `<tr><td>${esc(b.botId)}</td><td class="n">${rupees(b.totalPaise)}</td><td class="n">${pct(b.returnOnBudgetPct)}</td>`
      + `<td class="n">${k && k.excessPct !== null ? `${pct(k.returnPct)} vs ${pct(k.basketReturnPct)}` : '—'}</td>`
      + `<td class="n ${k?.excessPct > 0 ? 'up' : k?.excessPct < 0 ? 'down' : ''}">${k && k.excessPct !== null ? pct(k.excessPct) : '—'}</td>`
      + `<td>${k ? `${esc(k.from)} to ${esc(k.to)}` : '—'}</td></tr>`;
  }).join('');
  return `<p>Each bot trades paper money on new days only, with Indian delivery charges and slippage, and is compared with simply
holding all eight shares equally over the same days. A few weeks prove nothing; the comparison is shown so it can be followed.</p>
<div class="scroll"><table><thead><tr><th>Bot</th><th class="n">Paper P&amp;L</th><th class="n">On its budget</th><th class="n">Return vs basket</th><th class="n">Ahead / behind</th><th>Days</th></tr></thead>
<tbody>${rows || '<tr><td colspan="6">No bot has traded yet.</td></tr>'}</tbody></table></div>
<p class="muted">Total paper P&amp;L ${rupees(live.money?.totalPaise)} (realised ${rupees(live.money?.realisedPaise)}, open ${rupees(live.money?.unrealisedPaise)}).
${(live.liveFitness ?? []).length ? '' : 'No bot has enough scored live calls for a verdict yet.'}</p>`;
}

function researchSection(scout) {
  if (!scout) return '<p class="muted">No research report yet.</p>';
  const best = scout.candidates.slice(0, 6), b = scout.basketStats, wf = scout.walkForward;
  const width = v => Math.min(100, Math.abs(v) / 0.6 * 100).toFixed(0);
  const rows = best.map(c => `<tr><td>${esc(c.name)}</td><td class="n">${c.ahead}/${c.behind}</td>
<td class="n"><span class="bar ${c.averageExcessPct >= 0 ? 'pos' : 'neg'}" style="width:${width(c.averageExcessPct)}%"></span>${pct(c.averageExcessPct, 3)}</td>
<td class="n">${num(c.pValue, 3)}</td><td class="n">${c.beatsRandomPct ?? '—'}%</td><td class="n">${pct(c.stats?.cagrPct)}</td><td class="n">${pct(c.stats?.maxDrawdownPct)}</td>
<td class="n">${pct(c.proof?.afterTaxCagrPct)}</td></tr>`).join('');
  return `<p>Every monthly allocation idea for the eight shares, judged on ${esc(scout.from)} to ${esc(scout.through)}, net of costs, against holding
all eight equally. With ${scout.ideasTried} ideas tried, an idea must reach p &lt; ${num(scout.bonferroniThreshold, 4)} to pass, so that the best of many
lucky ideas is not mistaken for skill. <strong>None passes.</strong></p>
<div class="scroll"><table><thead><tr><th>Idea (best six)</th><th class="n">Months ahead/behind</th><th class="n">Excess a month</th><th class="n">p</th>
<th class="n">Beats random pickers</th><th class="n">A year</th><th class="n">Worst fall</th><th class="n">A year after tax</th></tr></thead>
<tbody>${rows}<tr class="base"><td>Hold all eight equally</td><td></td><td></td><td></td><td></td><td class="n">${pct(b.cagrPct)}</td><td class="n">${pct(b.maxDrawdownPct)}</td><td class="n">${pct(b.afterTaxCagrPct)}</td></tr></tbody></table></div>
${wf ? `<p><strong>Choosing the best past idea each year</strong> (walk-forward, judged only on the following months): ${wf.ahead} months ahead, ${wf.behind} behind,
${pct(wf.averageExcessPct, 3)} a month. On this history, following yesterday's winner loses to simply holding the basket.</p>` : ''}`;
}

function factorSection(lab) {
  if (!lab) return '<p class="muted">No factor study yet.</p>';
  const passes = f => f.ic?.pValue !== undefined && f.ic.pValue < lab.bonferroniThreshold;
  const rows = [...lab.factors].sort((a, b) => (b.ic?.tStat ?? -9) - (a.ic?.tStat ?? -9)).map(f => `<tr><td>${esc(f.description)}</td><td class="n">${f.months}</td>
<td class="n">${num(f.ic?.mean, 4)}</td><td class="n ${passes(f) ? 'up' : ''}">${num(f.ic?.tStat)}</td><td class="n">${num(f.ic?.positiveMonthsPct, 0)}%</td>
<td>${passes(f) ? '<strong>passes</strong>' : 'no'}</td></tr>`).join('');
  const passing = lab.factors.filter(passes).map(f => f.description);
  return `<p>The same question on a wide universe: about ${esc(lab.sharesWithData ?? '')} NIFTY 500 shares each month, ${esc(lab.from)} to ${esc(lab.through)}.
The information coefficient (IC) is the rank correlation between a signal and the next month's return; its t-statistic says how
steady it was. ${lab.factorsTried} signals were tried, so a pass needs p &lt; ${num(lab.bonferroniThreshold, 4)}.</p>
<div class="scroll"><table><thead><tr><th>Signal</th><th class="n">Months</th><th class="n">Mean IC</th><th class="n">t</th><th class="n">Months positive</th><th>Passes the bar</th></tr></thead><tbody>${rows}</tbody></table></div>
<p>${passing.length ? `<strong>${passing.length === 1 ? 'One signal passes' : `${passing.length} signals pass`}:</strong> ${esc(passing.join('; '))}. On the wide market, shares that rose most
over the past year kept doing a little better the next month. On our eight shares the same idea did not pass: eight shares are too few to tell.`
    : 'No signal passes the bar.'}</p>
<p class="muted">Today's index members over past years: companies that left the index are missing, which flatters momentum and trend.
The strongest signal is therefore being re-tested forward, on months after its registration only.</p>`;
}

function regimeSection(regime, study) {
  if (!regime) return '';
  const levels = study?.levels;
  const fall = l => (levels?.[l]?.fallOver5PctShare === undefined ? null : Math.round(100 * levels[l].fallOver5PctShare));
  return `<p>The market's state today, from the eight shares' own prices (distribution days, breadth and the 200-day trend):
<strong>${esc(regime.risk)}</strong> on ${esc(regime.date)}, with ${esc(regime.distributionDays)} distribution day(s) in 25 sessions and
${esc(regime.breadth200d)} of 8 shares above their 200-day average.${fall('SEVERE') !== null ? ` On our history, falls of more than 5% within 20 sessions
followed ${fall('SEVERE')}% of SEVERE days and ${fall('NORMAL')}% of NORMAL ones.` : ''} It is advice for the organisation, never a trade by itself.</p>`;
}

function lessonsSection(mentor) {
  if (!mentor) return '';
  const by = s => mentor.lessons.filter(l => l.status === s);
  const show = mentor.lessons.filter(l => l.status === 'checked' && l.evidence).slice(0, 6);
  return `<p>Classic trading tips are taught to the models only after they are checked on our own data: ${by('checked').length} of ${mentor.lessons.length}
hold, ${by('contradicted').length} are contradicted, ${by('unverified').length} have no check yet.</p>
<ul class="lessons">${show.map(l => `<li><strong>${esc(l.title)}.</strong> ${esc(String(l.evidence).slice(0, 300))}</li>`).join('')}</ul>`;
}

function awarenessSection(world, rndForward, tuning, exams) {
  const parts = [];
  if (world) parts.push(`<li>News from official bodies and publishers in India, the US, the UK, China and worldwide: ${world.items} items in the last ${world.windowHours} hours,
${world.reachingShares} stories reaching the shares, and ${world.worldEchoes ?? 0} world event(s) followed by Indian coverage on the same economic driver.
News is context, verified by an independent fact-checker before it can teach a bot; it is never a trade by itself.</li>`);
  if (rndForward) parts.push(`<li>Pre-registered forward tests: ${rndForward.running} idea(s) waiting for months nobody has seen yet; a verdict comes after 24 such months.</li>`);
  if (tuning) parts.push(`<li>The local language model runs on a laptop CPU, writing about ${num(tuning.generatedTokensPerSecond, 1)} tokens (word pieces) a second; a typical decision takes about ${Math.round(tuning.secondsPerCall)} seconds.</li>`);
  if (exams?.verdict || exams?.summary) parts.push(`<li>The model sits fixed exams on its own past mistakes: ${esc(exams.verdict ?? exams.summary)}.</li>`);
  return parts.length ? `<ul>${parts.join('')}</ul>` : '';
}

export function buildPage(data, now = new Date()) {
  const regime = regimeSection(data.regime, data.regimeStudy);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Trading desk results</title>
<style>
:root{--bg:#f7f7f4;--fg:#1d1f21;--muted:#62666b;--line:#d9dad5;--card:#fff;--up:#0f7b4f;--down:#b42318;--bar:#9fb7d9}
@media (prefers-color-scheme:dark){:root{--bg:#141518;--fg:#e9e9e6;--muted:#a3a6ab;--line:#30333a;--card:#1c1e22;--up:#4cc38a;--down:#ff8a80;--bar:#3f5f8a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:980px;margin:0 auto;padding:28px 16px 48px}h1{font-size:1.9rem;margin:.2rem 0 .4rem}h2{font-size:1.25rem;margin:2.2rem 0 .6rem;padding-top:.6rem;border-top:1px solid var(--line)}
.eyebrow{text-transform:uppercase;letter-spacing:.08em;font-size:.78rem;color:var(--muted)}.muted{color:var(--muted);font-size:.92rem}
.scroll{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:8px}table{border-collapse:collapse;width:100%;font-size:.93rem}
th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top;white-space:nowrap}th{font-weight:600;color:var(--muted)}td:first-child{white-space:normal}
.n{text-align:right;font-variant-numeric:tabular-nums}.up{color:var(--up)}.down{color:var(--down)}tr.base td{font-weight:600}
.bar{display:inline-block;height:8px;border-radius:4px;margin-right:6px;vertical-align:middle;background:var(--bar)}.bar.neg{opacity:.55}
.lessons li,ul li{margin:.35rem 0}footer{margin-top:2.5rem;color:var(--muted);font-size:.88rem;border-top:1px solid var(--line);padding-top:1rem}
</style></head><body><div class="wrap">
<header><span class="eyebrow">AI trading desk · paper only</span><h1>Trading desk results</h1>
<p>A team of AI agents researches and paper-trades eight large NSE shares (four of them banks). Bots propose, a deterministic review and
independent agents check, and every idea must beat simply holding all eight shares, after costs, before it counts. No real money, no real orders.</p></header>
<h2>Live paper books</h2>${liveSection(data.live)}
<h2>Ten years of research on the eight shares</h2>${researchSection(data.scout)}
<h2>The wide market: which signals carry information</h2>${factorSection(data.lab)}
${regime ? `<h2>Market state</h2>${regime}` : ''}
<h2>What the models are taught</h2>${lessonsSection(data.mentor)}
<h2>Awareness and forward tests</h2>${awarenessSection(data.world, data.rndForward, data.tuning, data.exams)}
<footer><p>Built ${esc(now.toISOString().slice(0, 16).replace('T', ' '))} UTC from the desk's saved analyses. Prices: delayed daily data, used only for
these statistics. Paper results on new days only; research on past data screens ideas and cannot prove them. Nothing here is advice.</p></footer>
</div></body></html>
`;
}

/** Anything that must never reach the public page: local paths, credentials, settings names, e-mail addresses. */
export function privacyProblems(page) {
  const checks = [[/[A-Za-z]:\\/, 'a local Windows path'], [/\/(?:Users|home)\//, 'a local path'], [/Bearer\s|PRINCIPALS|API_TOKEN|\.env\b/i, 'a credential or setting'],
    [/[\w.+-]+@[\w-]+\.[\w.]+/, 'an e-mail address'], [/Trading[- ]Organisation/i, "the project's name"], [/\bsk-[A-Za-z0-9]{8,}/, 'a key']];
  return checks.filter(([re]) => re.test(page)).map(([, what]) => what);
}

async function liveDigest(env) {
  const owner = JSON.parse(env.PRINCIPALS_JSON || '[]').find(p => p.role === 'owner');
  if (!owner) return null;
  try {
    const r = await fetch((env.API_URL || 'http://127.0.0.1:3000') + '/v1/owner/digest', { method: 'POST', body: '{}', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + owner.token }, signal: AbortSignal.timeout(15_000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function main() {
  const page = buildPage(gather(await liveDigest(process.env)));
  const problems = privacyProblems(page);
  const out = L('trading-desk', 'results-page.html');
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, page);
  if (problems.length) throw new Error(`The page contains ${problems.join(', ')}; not published (written to ${out} for checking)`);
  if (!process.argv.includes('--publish')) { console.log(JSON.stringify({ state: 'built', path: out, bytes: page.length })); return; }
  const repo = L('results-repo');
  const git = (args, cwd = repo) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error(`git ${args[0]}: ${(r.stderr || r.stdout).trim().slice(-200)}`); return r.stdout; };
  if (!existsSync(join(repo, '.git'))) git(['clone', '-q', PUBLIC_REPO, repo], ROOT);
  git(['pull', '-q', '--ff-only']);
  await copyFile(out, join(repo, 'index.html'));
  await writeFile(join(repo, 'README.md'), README);
  if (!git(['status', '--porcelain']).trim()) { console.log(JSON.stringify({ state: 'unchanged' })); return; }
  git(['add', 'index.html', 'README.md']);
  git(['commit', '-q', '-m', `Results as of ${new Date().toISOString().slice(0, 10)}`]);
  git(['push', '-q']);
  console.log(JSON.stringify({ state: 'published', url: 'https://keerthanmuniraja.github.io/trading-desk-results/' }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error('results-page: ' + error.message); process.exitCode = 1; });
}
