// Daily owner digest (OBS-01): fetch /v1/owner/digest with the evaluator credential, write a readable Markdown note to
// .local/digests/<day>.md, and, when ALERT_WEBHOOK_URL is set, post a short summary there too.
//   node --env-file=.env scripts/daily-digest.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { settings } from './deliver-alerts.mjs';

const rupees = paise => {
  const n = Number(BigInt(paise)) / 100;
  return (n < 0 ? '−₹' : '₹') + Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
};

export function render(d) {
  const t = d.trading, k = d.knowledge, m = d.money;
  const lines = [
    `# Organisation digest — ${d.generatedAt.slice(0, 10)}`, '',
    `Window: last ${d.windowHours} hours · mode: ${d.mode}${d.halted ? ' · **NEW RISK HALTED**' : ''}`, '',
    '## Needs you',
    ...(d.needsOwner.length ? d.needsOwner.map(n => `- ${n}`) : ['- Nothing right now.']), '',
    '## Money (paper)',
    `- Total P&L ${rupees(m.totalPaise)} (realised ${rupees(m.realisedPaise)}, open ${rupees(m.unrealisedPaise)}); realised in window ${rupees(m.realisedInWindowPaise)}`,
    ...m.byBot.map(b => `- ${b.botId}: ${rupees(b.totalPaise)}${b.returnOnBudgetPct !== null ? ` (${b.returnOnBudgetPct}% of budget)` : ''}`),
    ...(m.stalePositions ? [`- ${m.stalePositions} open position(s) without a recent verified price: their value is unreliable`] : []), '',
    '## Trading',
    `- ${t.proposed} proposed, ${t.accepted} accepted, ${t.rejected} rejected, ${t.executed} executed, ${t.challenges} challenges`,
    `- ${t.scored} outcomes scored${t.accuracy !== null ? `, ${Math.round(t.accuracy * 100)}% right` : ''}`,
    ...(t.lapsed ? [`- ${t.lapsed} accepted proposal(s) expired unexecuted; ${rupees(t.releasedPaise ?? '0')} of reservations released`] : []),
    ...(t.corporateActions ? [`- ${t.corporateActions} corporate action(s) recorded; positions rescaled`] : []), '',
    '## Against holding all shares equally (same days)',
    ...((d.benchmark ?? []).length ? d.benchmark.map(b => b.excessPct === null ? `- ${b.botId}: no basket prices for ${b.from}..${b.to} yet`
      : `- ${b.botId} ${b.from}..${b.to}: ${b.returnPct > 0 ? '+' : ''}${b.returnPct}% vs basket ${b.basketReturnPct > 0 ? '+' : ''}${b.basketReturnPct}%`
        + ` — ${b.excessPct > 0 ? 'ahead' : b.excessPct < 0 ? 'behind' : 'level'} by ${Math.abs(b.excessPct)} points`)
      : ['- No bot has two daily snapshots yet.']), '',
    '## Organisation',
    `- Suspended bots: ${(d.organisation?.suspendedBots ?? []).join(', ') || 'none'}`,
    ...(d.organisation ? [`- Departments: ${d.organisation.departmentsActive} active, ${d.organisation.departmentsClosed} closed; `
      + `hackathons: ${d.organisation.hackathonsOpen} open, ${d.organisation.hackathonsJudging} being judged`] : []), '',
    '## Live fitness (paper calls on new days)',
    ...((d.liveFitness ?? []).length ? d.liveFitness.map(f => `- ${f.botId} (${f.scope}): ${f.verdict}, ${f.right} of ${f.judged} right`)
      : ['- No bot has scored live calls yet.']), '',
    '## Knowledge',
    `- ${k.received} items received, ${k.verified} verified, ${k.rejected} rejected; ${k.backlog} waiting for review`
      + (k.setAside ? ` (${k.setAside} more set aside as out of scope)` : ''), '',
    '## Bots (90-day scored accuracy, 5+ calls)',
    ...(d.bots.best.length ? d.bots.best.map(b => `- best: ${b.botId} ${Math.round(b.accuracy * 100)}% of ${b.scored}`) : ['- No bot has 5 scored calls yet.']),
    ...d.bots.weakest.map(b => `- weakest: ${b.botId} ${Math.round(b.accuracy * 100)}% of ${b.scored}`), '',
    `Alerts open: ${Object.entries(d.alerts).map(([s, n]) => `${n} ${s}`).join(', ') || 'none'} · model tokens: ${d.compute.tokens}`, '',
    `_${d.note}_`, ''];
  return lines.join('\n');
}

export async function run(env = process.env, { fetchImpl = fetch, outDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.local', 'digests') } = {}) {
  const s = settings(env);
  const response = await fetchImpl(s.base + '/v1/owner/digest', { method: 'POST', redirect: 'error', body: '{}',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.token } });
  if (!response.ok) throw new Error(`digest refused (HTTP ${response.status})`);
  const digest = await response.json();
  const text = render(digest);
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
