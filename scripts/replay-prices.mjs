// Replay prices (REPLAY-02): the replay's stand-in for the market-data download. From the full price history it writes
// each share's daily file with only the sessions that had closed at the current (virtual) time: a session counts once
// it is 16:00 IST or later that day. Run under the replay clock, so a replayed day sees exactly its own past and never
// the future. No network.
//   node --import ./scripts/replay-clock.mjs scripts/replay-prices.mjs <full-history-dir> <daily-dir>
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const IST = 330 * 60_000, CLOSED_AFTER_MINUTES = 16 * 60;

/** The last session date that had closed at `now` (ms): today from 16:00 IST, otherwise yesterday. */
export function lastClosedDay(now) {
  const india = new Date(now + IST);
  const minutes = india.getUTCHours() * 60 + india.getUTCMinutes();
  const day = new Date(Date.UTC(india.getUTCFullYear(), india.getUTCMonth(), india.getUTCDate()) - (minutes >= CLOSED_AFTER_MINUTES ? 0 : 86_400_000));
  return day.toISOString().slice(0, 10);
}

export async function writeUpTo(fullDir, dailyDir, now = Date.now()) {
  const through = lastClosedDay(now);
  await mkdir(dailyDir, { recursive: true });
  const out = [];
  for (const name of (await readdir(fullDir)).filter(n => n.endsWith('-1d.json')).sort()) {
    const data = JSON.parse(await readFile(join(fullDir, name), 'utf8'));
    const bars = data.bars.filter(b => b.date <= through);
    await writeFile(join(dailyDir, name), JSON.stringify({ ...data, bars, retrievedAt: new Date(now).toISOString() }));
    out.push({ symbol: data.symbol, state: 'downloaded', bars: bars.length, lastSession: bars.at(-1)?.date ?? null });
  }
  return { through, shares: out };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [fullDir, dailyDir] = process.argv.slice(2);
  if (!fullDir || !dailyDir) { console.error('Usage: replay-prices.mjs <full-history-dir> <daily-dir>'); process.exit(2); }
  const r = await writeUpTo(fullDir, dailyDir);
  // the same report shape the cycle's market-data check reads (verifyMarketData)
  console.log(JSON.stringify(r.shares));
}
