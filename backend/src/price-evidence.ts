import { requireThat } from './core.js';
import { Sql } from './database.js';

// Price evidence (PAPER-04): one strict rule for every place a price comes from evidence instead of a live quote (an
// end-of-day review, an end-of-day fill, a valuation mark, an outcome's exit price). The evidence must be verified, from
// an approved source, and state EXACTLY ONE price in the form `NSE:<share> on <YYYY-MM-DD>: <price> paise`, for this share
// and this price, dated on the India trading day of its own publication time. The observation time is that publication
// time (set by the reporter, confirmed by the independent checker), never a time the caller chooses. So a price cannot
// be taken from another share's line, from a table of several prices, or re-dated to look fresh or to follow a review.

const PRICE_LINE = /NSE:([A-Z][A-Z0-9._-]{0,19}) on (\d{4}-\d{2}-\d{2}): ([1-9][0-9]{0,13}) paise/g;
const indiaDay = (ms: number) => new Date(ms + 330 * 60_000).toISOString().slice(0, 10);
export type PriceEvidence = { evidenceId: string; pricePaise: string; observedAt: string };

/** The price and its observation time (ms), or a refusal. `maxAgeDays: null` accepts any age (scoring after a horizon). */
export async function verifiedPrice(tx: Sql, ticker: string, e: PriceEvidence, { maxAgeDays = 7 as number | null } = {}) {
  const row = (await tx.query('SELECT e.content,e.status,e.published_at,s.approved FROM evidence e JOIN sources s ON s.id=e.source_id WHERE e.id=$1',
    [e.evidenceId])).rows[0];
  requireThat(row && row.status === 'verified' && row.approved === true, 'Price evidence must be verified and from an approved source');
  const lines = [...String(row.content).matchAll(PRICE_LINE)];
  requireThat(lines.length === 1, 'Price evidence must state exactly one price, as "NSE:<share> on <date>: <price> paise"');
  const [, share, day, price] = lines[0]!;
  requireThat(share === ticker && price === e.pricePaise, 'Price evidence does not state this price for this share');
  const at = new Date(row.published_at).getTime();
  requireThat(Date.parse(e.observedAt) === at, 'The observation time must be the evidence\'s own publication time');
  requireThat(day === indiaDay(at), 'The date in the evidence does not match its publication day');
  requireThat(at <= Date.now() + 60_000, 'Price evidence cannot be from the future');
  if (maxAgeDays !== null) requireThat(at >= Date.now() - maxAgeDays * 86_400_000, `Price evidence must be from the last ${maxAgeDays} days`);
  return { pricePaise: BigInt(price!), observedAt: at };
}
