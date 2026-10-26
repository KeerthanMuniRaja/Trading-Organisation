import { Body, Controller, Get, Headers, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { Actor, id, parse, permit, requireThat, symbol, timestamp, uuid } from './core.js';
import { Database, Sql, audit } from './database.js';
import { Allow } from './security.js';
import { verifiedPrice } from './price-evidence.js';
import { restated } from './corporate-actions.js';

// Paper performance (part of PAPER-01): per-bot profit and loss, read only from the append-only ledger and positions.
// Realised P&L is the bot's share of the PNL account (fees on buys, gains or losses on sells; PNL entries are debits,
// so profit is their negative). Open positions are marked at the latest approved bid, a conservative liquidation
// value; the quote's age is shown and positions without any quote are marked at cost and flagged.
// Daily snapshots keep an append-only equity history per bot (the first snapshot of each India trading day stands),
// from which the history view derives each bot's equity curve, return and worst fall.
// Nothing here can move money, change a limit or alter a bot.

// PAPER-02: without a live feed, a position may instead be marked at a verified daily close (price_marks, recorded by the
// evaluator from verified evidence). The newer of the two prices wins. A live quote is current for a day; a daily close
// for four (a weekend plus one exchange holiday), since no newer close exists in between.
type Row = Record<string, any>;
const money = (v: bigint) => v.toString();
const STALE_SECONDS = 86_400; // a live quote older than a day is stale
export const MARK_STALE_SECONDS = 4 * 86_400;
const historySchema = z.object({ botId: id.optional(), days: z.number().int().min(1).max(3650).default(365) }).strict();
const benchmarkSchema = z.object({ botId: id.optional() }).strict();
const markSchema = z.object({ symbol, priceEvidence: z.object({ evidenceId: z.uuid(), pricePaise: z.string().regex(/^[1-9][0-9]{0,13}$/), observedAt: timestamp }).strict() }).strict();

/** India trading day of a moment (NSE dates are IST). */
export function indiaDay(ms: number) { return new Date(ms + 330 * 60_000).toISOString().slice(0, 10); }

/** Equity series -> total return and worst peak-to-trough fall, both in percent. */
export function curveStats(equity: bigint[]) {
  if (!equity.length) return { returnPct: null, maxDrawdownPct: null };
  let peak = equity[0]!, worst = 0n;
  for (const e of equity) {
    if (e > peak) peak = e;
    if (peak > 0n && (peak - e) * 1_000_000n / peak > worst) worst = (peak - e) * 1_000_000n / peak;
  }
  const first = equity[0]!, last = equity[equity.length - 1]!;
  return { returnPct: first > 0n ? Number((last - first) * 1_000_000n / first) / 10_000 : null, maxDrawdownPct: Number(worst) / 10_000 };
}

/** Daily snapshots -> a performance curve in which a budget change is money moving in or out, not a gain or a loss (a
 *  time-weighted return): it starts at the first day's equity and then moves only by each day's P&L change, measured on
 *  the previous day's capital. For a bot whose budget never changed it equals budget + P&L exactly. Without this, a 25%
 *  budget cut read as a 25% fall: a deep-drawdown watch, a drawdown alert, and 25 points "behind the basket", which
 *  invited the next cut. */
export function performanceCurve(snaps: { budget: string; realised: string; unrealised: string }[]): bigint[] {
  const out: bigint[] = [];
  let base = 0n, pnlBefore = 0n;
  for (const s of snaps) {
    const pnl = BigInt(s.realised) + BigInt(s.unrealised);
    if (!out.length) out.push(BigInt(s.budget) + pnl);
    else {
      const before = base + pnlBefore, last = out[out.length - 1]!;
      out.push(before > 0n ? last * (base + pnl) / before : last);
    }
    base = BigInt(s.budget);
    pnlBefore = pnl;
  }
  return out;
}

export async function compute(tx: Sql, only: string | null, now: number) {
  const bots = (await tx.query(`SELECT id,name,state,budget_paise::text AS budget FROM bots
    WHERE ($1::text IS NULL OR id=$1) AND (state='paper' OR id IN (SELECT bot_id FROM orders)) ORDER BY id`, [only])).rows;
  const realised = new Map<string, bigint>((await tx.query(`SELECT j.metadata->>'botId' AS bot,(-SUM(e.amount))::text AS value
    FROM entries e JOIN journals j ON j.id=e.journal_id WHERE e.account='PNL' AND j.kind IN ('paper-buy','paper-sell','paper-dividend')
    GROUP BY j.metadata->>'botId'`)).rows.map((r: Row) => [r.bot, BigInt(r.value)]));
  const trades = new Map<string, Row>((await tx.query(`SELECT o.bot_id,COUNT(*)::int AS fills,COALESCE(SUM(f.fee_paise),0)::text AS fees,
      COUNT(*) FILTER (WHERE o.side='sell')::int AS closes,
      COUNT(*) FILTER (WHERE o.side='sell' AND (SELECT SUM(amount) FROM entries WHERE journal_id=f.journal_id AND account='PNL')<0)::int AS winning
    FROM fills f JOIN orders o ON o.id=f.order_id GROUP BY o.bot_id`)).rows.map((r: Row) => [r.bot_id, r]));
  const reserved = new Map<string, bigint>((await tx.query(`SELECT bot_id,SUM(reserved_paise)::text AS value FROM orders
    WHERE status='reserved' GROUP BY bot_id`)).rows.map((r: Row) => [r.bot_id, BigInt(r.value)]));
  const positions = (await tx.query(`SELECT p.bot_id,p.symbol,p.quantity::text AS qty,p.cost_paise::text AS cost,q.bid::text AS bid,q.observed_at,
      m.price_paise::text AS mark,m.observed_at AS mark_at
    FROM positions p LEFT JOIN (SELECT q.* FROM quotes q JOIN sources s ON s.id=q.source_id AND s.approved=true) q ON q.symbol=p.symbol
    LEFT JOIN LATERAL (SELECT price_paise,observed_at FROM price_marks WHERE symbol=p.symbol ORDER BY observed_at DESC LIMIT 1) m ON true
    WHERE p.quantity>0 AND ($1::text IS NULL OR p.bot_id=$1) ORDER BY p.bot_id,p.symbol`, [only])).rows;
  return bots.map((b: Row) => {
    const open = positions.filter((p: Row) => p.bot_id === b.id).map((p: Row) => {
      const quoteAt = p.bid ? new Date(p.observed_at).getTime() : null, markAt = p.mark ? new Date(p.mark_at).getTime() : null;
      const useMark = markAt !== null && (quoteAt === null || markAt > quoteAt);
      const price = useMark ? BigInt(p.mark) : p.bid ? BigInt(p.bid) : null, at = useMark ? markAt : quoteAt;
      const qty = BigInt(p.qty), cost = BigInt(p.cost), value = price !== null ? price * qty : cost;
      const age = at !== null ? Math.max(0, Math.round((now - at) / 1000)) : null;
      return { symbol: p.symbol, quantity: p.qty, costPaise: money(cost), marketValuePaise: money(value), unrealisedPaise: money(value - cost),
        priceAgeSeconds: age, valuation: useMark ? 'verified-close' : p.bid ? 'latest-approved-bid' : 'no-quote-held-at-cost',
        stale: age === null || age > (useMark ? MARK_STALE_SECONDS : STALE_SECONDS) };
    });
    const cost = open.reduce((s, p) => s + BigInt(p.costPaise), 0n), unrealised = open.reduce((s, p) => s + BigInt(p.unrealisedPaise), 0n);
    const real = realised.get(b.id) ?? 0n, t = trades.get(b.id), used = cost + (reserved.get(b.id) ?? 0n);
    return { botId: b.id as string, name: b.name as string, state: b.state as string, budgetPaise: b.budget as string, budgetUsedPaise: money(used),
      realisedPaise: money(real), unrealisedPaise: money(unrealised), totalPaise: money(real + unrealised),
      returnOnBudgetPct: BigInt(b.budget) > 0n ? Number((real + unrealised) * 10000n / BigInt(b.budget)) / 100 : null,
      feesPaise: (t?.fees ?? '0') as string, fills: (t?.fills ?? 0) as number, closingTrades: (t?.closes ?? 0) as number,
      winningClosingTrades: (t?.winning ?? 0) as number, openPositions: open };
  });
}

/** RISK-01: standard risk figures from a daily equity series, so the owner can oversee risk at a glance: annualised
 *  volatility, Sharpe ratio (risk-free rate 0, stated), 95% one-day historical value at risk (the loss exceeded on the
 *  worst 5% of days) and the worst fall. Null until there are at least 20 daily returns: fewer say nothing. */
export function riskStats(equity: bigint[]) {
  const returns: number[] = [];
  for (let i = 1; i < equity.length; i++) if (equity[i - 1]! > 0n) returns.push(Number(equity[i]! - equity[i - 1]!) / Number(equity[i - 1]!));
  if (returns.length < 20) return { days: returns.length, volatilityPct: null, sharpe: null, var95Pct: null, maxDrawdownPct: curveStats(equity).maxDrawdownPct };
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const sd = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1));
  const sorted = [...returns].sort((a, b) => a - b), worst5 = sorted[Math.floor(0.05 * (sorted.length - 1))]!;
  return { days: returns.length, volatilityPct: Number((sd * Math.sqrt(252) * 100).toFixed(2)),
    sharpe: sd > 0 ? Number((mean / sd * Math.sqrt(252)).toFixed(2)) : null, var95Pct: Number((Math.max(0, -worst5) * 100).toFixed(2)),
    maxDrawdownPct: curveStats(equity).maxDrawdownPct };
}

/** The equal-weight basket's return between two India trading days, from verified daily marks: every share marked on
 *  both days counts equally, with splits, bonuses and dividends between them restated (total return). Null when fewer
 *  than half of the marked shares have both marks. */
export async function basketReturn(tx: Sql, fromDay: string, toDay: string) {
  const rows = (await tx.query(`SELECT s.symbol,a.price_paise::text AS a,a.observed_at AS a_at,b.price_paise::text AS b,b.observed_at AS b_at
    FROM (SELECT DISTINCT symbol FROM price_marks) s
    LEFT JOIN LATERAL (SELECT price_paise,observed_at FROM price_marks m WHERE m.symbol=s.symbol
      AND ((m.observed_at AT TIME ZONE 'UTC') + interval '330 minutes')::date <= $1::date ORDER BY observed_at DESC LIMIT 1) a ON true
    LEFT JOIN LATERAL (SELECT price_paise,observed_at FROM price_marks m WHERE m.symbol=s.symbol
      AND ((m.observed_at AT TIME ZONE 'UTC') + interval '330 minutes')::date <= $2::date ORDER BY observed_at DESC LIMIT 1) b ON true
    ORDER BY s.symbol`, [fromDay, toDay])).rows;
  const both = rows.filter(r => r.a && r.b);
  if (!rows.length || both.length * 2 < rows.length) return null;
  let sum = 0;
  for (const r of both) {
    const start = (await restated(tx, r.symbol, BigInt(r.a), new Date(r.a_at).getTime(), new Date(r.b_at).getTime())).refPaise;
    sum += Number(BigInt(r.b) * 1_000_000n / start) / 1_000_000 - 1;
  }
  return { returnPct: Number((sum / both.length * 100).toFixed(2)), shares: both.length };
}

export type Benchmark = { botId: string; days: number; verdict: string; from?: string; to?: string; returnPct?: number | null;
  basketReturnPct?: number | null; basketShares?: number; excessPct?: number | null; firstSnapshot?: string; risk?: ReturnType<typeof riskStats> };

/** Per bot with at least two snapshots: its return against the basket's over the same days. */
export async function compare(tx: Sql, botId: string | null): Promise<Benchmark[]> {
  const rows = (await tx.query(`SELECT bot_id,to_char(day,'YYYY-MM-DD') AS d,budget_paise::text AS budget,realised_paise::text AS realised,
      unrealised_paise::text AS unrealised FROM paper_performance_snapshots WHERE ($1::text IS NULL OR bot_id=$1) ORDER BY bot_id,day`, [botId])).rows;
  const bots = new Map<string, Row[]>();
  for (const r of rows) bots.set(r.bot_id, [...(bots.get(r.bot_id) ?? []), r]);
  const out: Benchmark[] = [];
  for (const [id, list] of bots) {
    if (list.length < 2) { out.push({ botId: id, days: list.length, verdict: 'not-enough-days' }); continue; }
    const last = list[list.length - 1]!, curve = performanceCurve(list as { budget: string; realised: string; unrealised: string }[]);
    // a bot whose snapshots began before the basket's verified closes did is compared from the first of its days the
    // basket covers (same days on both sides), instead of not at all
    let start = 0, basket = await basketReturn(tx, list[0]!.d, last.d);
    while (!basket && start < list.length - 2) basket = await basketReturn(tx, list[++start]!.d, last.d);
    const first = list[start]!, days = curve.slice(start), from = curve[start]!, to = curve[curve.length - 1]!;
    const own = from > 0n ? Number((to - from) * 1_000_000n / from) / 10_000 : null;
    const excess = own === null || !basket ? null : Number((own - basket.returnPct).toFixed(2));
    out.push({ botId: id, from: first.d, to: last.d, days: days.length, returnPct: own === null ? null : Number(own.toFixed(2)),
      basketReturnPct: basket?.returnPct ?? null, basketShares: basket?.shares ?? 0, excessPct: excess,
      ...(start > 0 && basket ? { firstSnapshot: list[0]!.d } : {}), risk: riskStats(days),
      verdict: excess === null ? 'no-basket-marks' : excess > 0 ? 'ahead-of-basket' : excess < 0 ? 'behind-basket' : 'level-with-basket' });
  }
  return out;
}

export class PaperPerformance {
  constructor(private readonly db: Database) {}

  report(actor: Actor) {
    permit(actor, 'owner', 'trader');
    const only = actor.role === 'trader' ? actor.botId ?? '' : null;
    return this.db.transaction(async tx => {
      const now = Date.now(), perBot = await compute(tx, only, now);
      const sum = (k: 'realisedPaise' | 'unrealisedPaise' | 'totalPaise' | 'feesPaise') => money(perBot.reduce((s, b) => s + BigInt(b[k]), 0n));
      return { mode: 'paper', asOf: new Date(now).toISOString(), bots: perBot,
        organisation: only === null ? { realisedPaise: sum('realisedPaise'), unrealisedPaise: sum('unrealisedPaise'), totalPaise: sum('totalPaise'), feesPaise: sum('feesPaise') } : null,
        note: 'Paper results. Open positions are marked at the newer of the latest approved bid and the latest verified daily close; check stale before relying on them.' };
    }, false);
  }

  /** Records today's mark for every bot once (owner or evaluator, e.g. after the close). Re-running the same day changes nothing. */
  snapshot(actor: Actor, key: string) {
    permit(actor, 'owner', 'evaluator');
    return this.db.command(actor, 'paper-performance-snapshot', key, {}, async tx => {
      const now = Date.now(), day = indiaDay(now), perBot = await compute(tx, null, now);
      let recorded = 0;
      for (const b of perBot) {
        const unpriced = b.openPositions.filter(p => p.stale).length;
        const inserted = await tx.query(`INSERT INTO paper_performance_snapshots(id,day,bot_id,budget_paise,realised_paise,unrealised_paise,open_positions,
          unpriced_or_stale,recorder) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (day,bot_id) DO NOTHING RETURNING id`,
          [uuid(), day, b.botId, b.budgetPaise, b.realisedPaise, b.unrealisedPaise, b.openPositions.length, unpriced, actor.id]);
        recorded += inserted.rows.length;
      }
      await audit(tx, actor, 'paper.performance.snapshot', day, { day, recorded, bots: perBot.length });
      return { day, recorded, alreadyRecorded: perBot.length - recorded };
    });
  }

  /** PAPER-02: records a share's verified daily close as its valuation mark (evaluator or owner). The price must be stated
   *  in verified evidence from an approved source, at most 7 days old; marks only move forward in time per share. */
  mark(actor: Actor, key: string, raw: unknown) {
    permit(actor, 'owner', 'evaluator');
    const input = parse(markSchema, raw);
    return this.db.command(actor, 'paper-price-mark', key, input, async tx => {
      const price = (await verifiedPrice(tx, input.symbol, input.priceEvidence)).pricePaise.toString();
      const at = new Date(input.priceEvidence.observedAt).toISOString();
      const latest = (await tx.query(`SELECT price_paise::text AS price,observed_at FROM price_marks WHERE symbol=$1 ORDER BY observed_at DESC LIMIT 1`, [input.symbol])).rows[0];
      if (latest && new Date(latest.observed_at).toISOString() === at) {
        requireThat(latest.price === price, 'A different mark is already recorded for this share at this time');
        return { symbol: input.symbol, pricePaise: price, observedAt: at, duplicate: true };
      }
      requireThat(!latest || new Date(latest.observed_at).getTime() < Date.parse(at), 'Marks must move forward in time');
      const markId = uuid();
      await tx.query('INSERT INTO price_marks(id,symbol,price_paise,observed_at,evidence_id,recorded_by) VALUES($1,$2,$3,$4,$5,$6)',
        [markId, input.symbol, price, at, input.priceEvidence.evidenceId, actor.id]);
      await audit(tx, actor, 'paper.mark.recorded', input.symbol, { markId, pricePaise: price, observedAt: at, evidenceId: input.priceEvidence.evidenceId });
      return { symbol: input.symbol, pricePaise: price, observedAt: at, duplicate: false };
    });
  }

  /** The latest verified mark per share. */
  marks(actor: Actor) {
    permit(actor, 'owner', 'evaluator', 'trader', 'researcher');
    return this.db.transaction(async tx => ({ marks: (await tx.query(`SELECT DISTINCT ON (symbol) symbol,price_paise::text AS price,observed_at,evidence_id
      FROM price_marks ORDER BY symbol,observed_at DESC`)).rows.map((r: Row) => ({ symbol: r.symbol, pricePaise: r.price,
        observedAt: new Date(r.observed_at).toISOString(), evidenceId: String(r.evidence_id) })) }), false);
  }

  /** BENCH-01: is each bot beating simply holding the basket? Its return on budget between its first and latest daily
   *  snapshot, against the equal-weight basket's total return over the same days from verified marks. Descriptive. */
  benchmark(actor: Actor, raw: unknown) {
    permit(actor, 'owner', 'evaluator', 'trader');
    const input = parse(benchmarkSchema, raw);
    const botId = actor.role === 'trader' ? actor.botId ?? '' : input.botId ?? null;
    return this.db.transaction(async tx => ({ bots: await compare(tx, botId),
      note: 'Return on the bot\'s whole budget (idle cash included) against holding all tracked shares equally over the same days. '
        + 'A few weeks prove nothing; fitness reports judge significance.' }), false);
  }

  /** Equity curve per bot (budget + realised + unrealised at each day's snapshot), return and worst fall. */
  history(actor: Actor, raw: unknown) {
    permit(actor, 'owner', 'trader', 'evaluator');
    const input = parse(historySchema, raw);
    const botId = actor.role === 'trader' ? actor.botId ?? '' : input.botId ?? null;
    return this.db.transaction(async tx => {
      const rows = (await tx.query(`SELECT to_char(day,'YYYY-MM-DD') AS d,bot_id,budget_paise::text AS budget,realised_paise::text AS realised,
          unrealised_paise::text AS unrealised,unpriced_or_stale FROM paper_performance_snapshots
        WHERE ($1::text IS NULL OR bot_id=$1) AND day >= (CURRENT_DATE - $2::int) ORDER BY bot_id,day`, [botId, input.days])).rows;
      const bots = new Map<string, Row[]>();
      for (const r of rows) bots.set(r.bot_id, [...(bots.get(r.bot_id) ?? []), r]);
      return { bots: [...bots.entries()].map(([id, list]) => {
        const curve = list.map(r => ({ day: r.d as string, equityPaise: money(BigInt(r.budget) + BigInt(r.realised) + BigInt(r.unrealised)),
          totalPnlPaise: money(BigInt(r.realised) + BigInt(r.unrealised)), unpricedOrStale: r.unpriced_or_stale as number }));
        const performance = performanceCurve(list as { budget: string; realised: string; unrealised: string }[]);
        return { botId: id, days: curve.length, ...curveStats(performance), risk: riskStats(performance), curve };
      }), note: 'Equity is budget plus paper P&L at each daily snapshot. Return, worst fall and risk treat a budget change as money moving in or out, not as performance. Days with unpriced or stale marks are flagged.' };
    }, false);
  }
}

type Request = { actor: Actor };
@Controller('v1')
export class PaperPerformanceController {
  constructor(private readonly performance: PaperPerformance) {}
  @Get('paper/performance') @Allow('owner', 'trader') report(@Req() r: Request) { return this.performance.report(r.actor); }
  @Post('paper/performance/snapshots') @Allow('owner', 'evaluator') snapshot(@Req() r: Request, @Headers('idempotency-key') k: string) { return this.performance.snapshot(r.actor, k ?? ''); }
  @Post('paper/performance/history') @Allow('owner', 'trader', 'evaluator') history(@Req() r: Request, @Body() b: unknown) { return this.performance.history(r.actor, b); }
  @Post('paper/performance/benchmark') @Allow('owner', 'evaluator', 'trader') benchmark(@Req() r: Request, @Body() b: unknown) { return this.performance.benchmark(r.actor, b); }
  @Post('paper/marks') @Allow('owner', 'evaluator') mark(@Req() r: Request, @Headers('idempotency-key') k: string, @Body() b: unknown) { return this.performance.mark(r.actor, k ?? '', b); }
  @Get('paper/marks') @Allow('owner', 'evaluator', 'trader', 'researcher') marks(@Req() r: Request) { return this.performance.marks(r.actor); }
}
