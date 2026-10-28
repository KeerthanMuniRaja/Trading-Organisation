// Weekly review (OWNER-02): the trading week on one page, for the owner's weekend review. Files only, so it works with
// the backend stopped: each day's cycle, money against the basket (from the daily digests), the prediction record, the
// news fact-check totals, the model's exam verdict, the forward test and the market's sectors, then what waits for you.
//   npm run weekly                      (the week up to today)       npm run weekly -- --week-of 2026-10-26
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** Monday to Friday of the week containing `day` (YYYY-MM-DD). */
export function weekDays(day) {
  const d = new Date(day + 'T00:00:00Z'), back = (d.getUTCDay() + 6) % 7;
  return [0, 1, 2, 3, 4].map(k => new Date(d.getTime() + (k - back) * 86_400_000).toISOString().slice(0, 10));
}

const json = async path => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } };
const text = async path => { try { return await readFile(path, 'utf8'); } catch { return null; } };
/** One "## Heading" section of a digest, without its heading. */
export function section(markdown, heading) {
  const m = new RegExp(`(?:^|\\n)## ${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)`).exec(markdown ?? '');
  return m ? m[1].trim() : null;
}

export async function gather(days, root = ROOT) {
  const local = (...p) => join(root, '.local', ...p);
  const cycles = [];
  for (const day of days) {
    const j = await json(local('cycles', day + '.json'));
    if (!j) { cycles.push({ day, ran: false }); continue; }
    const steps = Object.entries(j.steps ?? {});
    cycles.push({ day, ran: true, finished: !!j.finishedAt, steps: steps.length,
      failed: steps.filter(([, s]) => s.status === 'failed').map(([id]) => id),
      minutes: j.startedAt && j.finishedAt ? Math.round((Date.parse(j.finishedAt) - Date.parse(j.startedAt)) / 60_000) : null });
  }
  const lastDigestDay = [...days].reverse().find(d => existsSync(local('digests', d + '.md')));
  const digest = lastDigestDay ? await text(local('digests', lastDigestDay + '.md')) : null;
  const claimRuns = ((await text(local('claims', 'auto', 'cycles.jsonl'))) ?? '').split('\n').filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(r => r && days.includes(String(r.at).slice(0, 10)));
  const news = claimRuns.reduce((t, r) => {
    const x = r.steps?.['analyst-extract'] ?? {}, e = r.steps?.['factcheck-evidence'] ?? {}, l = r.steps?.['factcheck-lessons'] ?? {};
    return { runs: t.runs + 1, read: t.read + (x.callsThisRun ?? 0), accepted: t.accepted + (x.accepted ?? 0),
      corroborated: t.corroborated + (e.corroborated ?? 0), headlines: Math.max(t.headlines, l.headlines ?? 0) };
  }, { runs: 0, read: 0, accepted: 0, corroborated: 0, headlines: 0 });
  const forward = existsSync(local('trading-desk', 'factor-forward', 'reports'))
    ? await json(local('trading-desk', 'factor-forward', 'reports', 'momentum-12-1-from-2026-11.json')) : null;
  return { days, cycles, digestDay: lastDigestDay ?? null, money: section(digest, 'Money (paper)'), basket: section(digest, 'Against holding all shares equally'),
    regime: section(digest, 'Market regime (advice)'), sectors: section(digest, 'Market pulse'),
    scenario: await json(local('trading-desk', 'scenario', 'record.json')), review: await json(local('trading-desk', 'review-scorecard.json')),
    news, exams: await json(local('model-eval', 'auto-last.json')), forward, reactions: await json(local('world', 'news-reactions.json')) };
}

/** Pure: the facts in, the page out. */
export function render(f) {
  const out = [`# Week of ${f.days[0]} to ${f.days.at(-1)}`, '', '## The cycles'];
  for (const c of f.cycles) out.push(!c.ran ? `- ${c.day}: did not run` : `- ${c.day}: ${c.finished ? 'finished' : 'NOT finished'}, ${c.steps} steps`
    + `${c.minutes !== null ? `, ${c.minutes} min` : ''}${c.failed.length ? `; failed: ${c.failed.join(', ')}` : '; no failures'}`);
  const ran = f.cycles.filter(c => c.ran).length;
  out.push(`- ${ran} of ${f.cycles.length} trading days ran${ran < f.cycles.length ? ' (a laptop off or asleep at 16:05 misses a day; the supervisor catches up the same day only)' : ''}`, '');
  if (f.money) out.push(`## Money (paper), from the ${f.digestDay} digest`, f.money, '');
  if (f.basket) out.push('## Against holding all shares equally', f.basket, '');
  const s = f.scenario?.panel;
  out.push('## Prediction record',
    `- Scenario panel: ${s ? `${s.right} right, ${s.wrong} wrong (${s.verdict}); ${f.scenario.waiting} call(s) waiting their 5 sessions` : 'no record yet'}`,
    `- Trade calls reviewed: ${f.review ? `${f.review.accepted?.scored ?? 0} accepted and ${f.review.rejected?.scored ?? 0} declined calls scored (${f.review.verdict})` : 'no scorecard yet'}`, '');
  out.push('## News', `- Fact-check runs: ${f.news.runs}; items read by the model: ${f.news.read}; claims accepted: ${f.news.accepted}; `
    + `corroborated: ${f.news.corroborated}; verified headlines now: ${f.news.headlines}`);
  if (f.reactions) out.push(`- Reaction study: ${f.reactions.reports} reported moves kept, ${f.reactions.measured} measured; a kind of news speaks from ${f.reactions.minCases} cases`);
  out.push('');
  out.push('## The model', f.exams ? `- Exams (${(f.exams.tasks ?? []).join(', ')}): ${f.exams.overall} on ${String(f.exams.at).slice(0, 10)}, ${f.exams.model}` : '- No automatic exam run yet', '');
  if (f.forward) out.push('## Momentum forward test', `- ${f.forward.status}: ${f.forward.monthsJudged ?? 0} of ${f.forward.monthsNeeded} months judged`
    + `${f.forward.averageExcessPct !== undefined ? `, top fifth ${f.forward.averageExcessPct}% a month against the list` : ''}`, '');
  if (f.regime) out.push('## Market regime', f.regime, '');
  if (f.sectors) out.push('## Market pulse (latest)', f.sectors, '');
  out.push('## Waiting for you', '- The weekend list at the top of founderReview.md (W1…), each with a recommendation and a command.', '');
  return out.join('\n');
}

async function main() {
  const i = process.argv.indexOf('--week-of');
  const day = i > 0 ? process.argv[i + 1] : new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  const days = weekDays(day);
  const page = render(await gather(days));
  await mkdir(join(ROOT, '.local', 'digests'), { recursive: true });
  const path = join(ROOT, '.local', 'digests', `week-${days[0]}.md`);
  await writeFile(path, page);
  console.log(JSON.stringify({ written: path }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
