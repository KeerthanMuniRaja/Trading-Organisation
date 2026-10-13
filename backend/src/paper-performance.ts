import { Body, Controller, Get, Headers, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { Actor, id, parse, permit, uuid } from './core.js';
import { Database, Sql, audit } from './database.js';
import { Allow } from './security.js';

// Paper performance (part of PAPER-01): per-bot profit and loss, read only from the append-only ledger and positions.
// Realised P&L is the bot's share of the PNL account (fees on buys, gains or losses on sells; PNL entries are debits,
// so profit is their negative). Open positions are marked at the latest approved bid, a conservative liquidation
// value; the quote's age is shown and positions without any quote are marked at cost and flagged.
// Daily snapshots keep an append-only equity history per bot (the first snapshot of each India trading day stands),
// from which the history view derives each bot's equity curve, return and worst fall.
// Nothing here can move money, change a limit or alter a bot.

type Row = Record<string, any>;
const money = (v: bigint) => v.toString();
const STALE_SECONDS = 86_400; // a mark older than a day is reported as stale in snapshots
const historySchema = z.object({ botId: id.optional(), days: z.number().int().min(1).max(3650).default(365) }).strict();

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

export async function compute(tx: Sql, only: string | null, now: number) {
  const bots = (await tx.query(`SELECT id,name,state,budget_paise::text AS budget FROM bots
    WHERE ($1::text IS NULL OR id=$1) AND (state='paper' OR id IN (SELECT bot_id FROM orders)) ORDER BY id`, [only])).rows;
  const realised = new Map<string, bigint>((await tx.query(`SELECT j.metadata->>'botId' AS bot,(-SUM(e.amount))::text AS value
    FROM entries e JOIN journals j ON j.id=e.journal_id WHERE e.account='PNL' AND j.kind IN ('paper-buy','paper-sell')
    GROUP BY j.metadata->>'botId'`)).rows.map((r: Row) => [r.bot, BigInt(r.value)]));
  const trades = new Map<string, Row>((await tx.query(`SELECT o.bot_id,COUNT(*)::int AS fills,COALESCE(SUM(f.fee_paise),0)::text AS fees,
      COUNT(*) FILTER (WHERE o.side='sell')::int AS closes,
      COUNT(*) FILTER (WHERE o.side='sell' AND (SELECT SUM(amount) FROM entries WHERE journal_id=f.journal_id AND account='PNL')<0)::int AS winning
    FROM fills f JOIN orders o ON o.id=f.order_id GROUP BY o.bot_id`)).rows.map((r: Row) => [r.bot_id, r]));
  const reserved = new Map<string, bigint>((await tx.query(`SELECT bot_id,SUM(reserved_paise)::text AS value FROM orders
    WHERE status='reserved' GROUP BY bot_id`)).rows.map((r: Row) => [r.bot_id, BigInt(r.value)]));
  const positions = (await tx.query(`SELECT p.bot_id,p.symbol,p.quantity::text AS qty,p.cost_paise::text AS cost,q.bid::text AS bid,q.observed_at
    FROM positions p LEFT JOIN (SELECT q.* FROM quotes q JOIN sources s ON s.id=q.source_id AND s.approved=true) q ON q.symbol=p.symbol
    WHERE p.quantity>0 AND ($1::text IS NULL OR p.bot_id=$1) ORDER BY p.bot_id,p.symbol`, [only])).rows;
  return bots.map((b: Row) => {
    const open = positions.filter((p: Row) => p.bot_id === b.id).map((p: Row) => {
      const qty = BigInt(p.qty), cost = BigInt(p.cost), value = p.bid ? BigInt(p.bid) * qty : cost;
      return { symbol: p.symbol, quantity: p.qty, costPaise: money(cost), marketValuePaise: money(value), unrealisedPaise: money(value - cost),
        priceAgeSeconds: p.observed_at ? Math.max(0, Math.round((now - new Date(p.observed_at).getTime()) / 1000)) : null,
        valuation: p.bid ? 'latest-approved-bid' : 'no-quote-held-at-cost' };
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
        note: 'Paper results. Open positions are marked at the latest approved bid; check priceAgeSeconds before relying on them.' };
    }, false);
  }

  /** Records today's mark for every bot once (owner or evaluator, e.g. after the close). Re-running the same day changes nothing. */
  snapshot(actor: Actor, key: string) {
    permit(actor, 'owner', 'evaluator');
    return this.db.command(actor, 'paper-performance-snapshot', key, {}, async tx => {
      const now = Date.now(), day = indiaDay(now), perBot = await compute(tx, null, now);
      let recorded = 0;
      for (const b of perBot) {
        const unpriced = b.openPositions.filter(p => p.priceAgeSeconds === null || p.priceAgeSeconds > STALE_SECONDS).length;
        const inserted = await tx.query(`INSERT INTO paper_performance_snapshots(id,day,bot_id,budget_paise,realised_paise,unrealised_paise,open_positions,
          unpriced_or_stale,recorder) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (day,bot_id) DO NOTHING RETURNING id`,
          [uuid(), day, b.botId, b.budgetPaise, b.realisedPaise, b.unrealisedPaise, b.openPositions.length, unpriced, actor.id]);
        recorded += inserted.rows.length;
      }
      await audit(tx, actor, 'paper.performance.snapshot', day, { day, recorded, bots: perBot.length });
      return { day, recorded, alreadyRecorded: perBot.length - recorded };
    });
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
        return { botId: id, days: curve.length, ...curveStats(curve.map(c => BigInt(c.equityPaise))), curve };
      }), note: 'Equity is budget plus paper P&L at each daily snapshot. Days with unpriced or stale marks are flagged.' };
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
}
