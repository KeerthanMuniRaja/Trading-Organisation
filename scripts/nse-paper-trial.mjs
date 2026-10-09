import { mkdir, writeFile, appendFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { fetchQuote, marketWindow, QuoteError } from '../integrations/kite/quotes.mjs';
import { PaperTrial } from '../integrations/kite/paper-trial.mjs';

const args = process.argv.slice(2);
if (args.length && !(args.length === 1 && args[0] === '--check')) {
  console.error('Usage: npm run paper:nse -- [--check]'); process.exit(1);
}
const apiKey = process.env.KITE_API_KEY;
const accessToken = process.env.KITE_ACCESS_TOKEN;
if (!apiKey || !accessToken) {
  console.error('Setup required: set KITE_API_KEY and KITE_ACCESS_TOKEN in .env.market. No trial started. See docs/nse-paper-trial.md.');
  process.exit(1);
}
if (!marketWindow(Date.now())) {
  console.error('Outside regular NSE weekday hours (09:15–15:30 IST). No trial started. Holidays also require fresh quotes.');
  process.exit(1);
}
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = join(root, '.local', 'nse-paper', `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
await mkdir(directory, { recursive: true });
const trial = new PaperTrial();
const report = { version: 1, mode: 'isolated-paper-diagnostic', provider: 'kite', symbol: 'NSE:RELIANCE',
  strategy: 'baseline-momentum-v1-not-an-AI-qualification', durationSeconds: args.length ? 0 : 1800,
  assumptions: { slippageBps: 5, illustrativeCostBpsPerSide: 10, maxPositionPercent: 20 },
  startedAt: new Date().toISOString(), status: 'running', acceptedQuotes: 0, rejectedQuotes: 0 };
async function save() {
  const temp = join(directory, 'report.tmp');
  await writeFile(temp, JSON.stringify({ ...report, ...trial.report() }, null, 2));
  await rename(temp, join(directory, 'report.json'));
}
let stopping = false;
const interrupt = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { stopping = true; interrupt.abort(); });
const deadline = performance.now() + (args.length ? 8000 : 1_800_000);
let failures = 0;
try {
  await save();
  console.log(`NSE:RELIANCE paper diagnostic. Report: ${join(directory, 'report.json')}`);
  while (!stopping && performance.now() < deadline && marketWindow(Date.now())) {
    const remaining = deadline - performance.now();
    const closing = !args.length && remaining <= 15_000;
    try {
      const quote = await fetchQuote({ apiKey, accessToken, previousTime: trial.lastQuote?.time ?? 0,
        timeoutMs: Math.max(1, Math.min(8000, Math.floor(remaining))) });
      if (stopping || performance.now() >= deadline) break;
      const action = args.length ? 'observe' : trial.step(quote, closing);
      report.acceptedQuotes++; failures = 0;
      await appendFile(join(directory, 'observations.jsonl'), JSON.stringify({ ...quote, action }) + '\n');
      await save();
      if (action !== 'hold') console.log(`${quote.observedAt}: ${action}`);
      if (args.length || closing || trial.halted) break;
    } catch (error) {
      if (!(error instanceof QuoteError)) throw error;
      report.rejectedQuotes++; failures++;
      report.lastQuoteError = error.message;
      await appendFile(join(directory, 'observations.jsonl'), JSON.stringify({ rejectedAt: new Date().toISOString(), error: error.message }) + '\n');
      await save();
      if (['KITE_ACCESS_DENIED', 'KITE_CREDENTIALS_REQUIRED'].includes(error.message) || failures >= 3) {
        report.status = 'data_unavailable'; process.exitCode = 1; break;
      }
    }
    await sleep(Math.max(1, Math.min(5000, deadline - performance.now())), undefined, { signal: interrupt.signal }).catch(() => {});
  }
  if (report.status === 'running') report.status = stopping ? 'interrupted' :
    report.acceptedQuotes === 0 ? 'no_data' : args.length ? 'feed_checked' : 'completed';
} catch {
  report.status = 'failed'; process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  report.openPositionNeedsReview = Boolean(trial.position);
  await save();
  console.log(`Status: ${report.status}. Realised simulated P&L: ₹${(trial.realisedNetPaise / 100).toFixed(2)}. Open position: ${Boolean(trial.position)}.`);
}
