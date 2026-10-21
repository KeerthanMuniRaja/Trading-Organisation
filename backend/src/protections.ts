import { Body, Controller, Headers, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { Actor, id, parse, permit, requireThat, uuid } from './core.js';
import { Database, Sql, audit } from './database.js';
import { Allow } from './security.js';

// Self-expiring protections (PROTECT-01, from freqtrade's protections and the trading-skills circuit breaker): brakes
// that pause a bot's NEW BUYS by themselves and lift by themselves, so the organisation can run unattended without a
// person having to resume anything. Exits are never blocked, so risk can only fall while a pause holds. The owner sets
// the thresholds (a policy, owner only, never the standing-approvals agent); with no policy nothing is paused. Checked
// wherever the halt is: the risk review (a recorded reason) and the paper order's reserve and fill (a refusal).
// Windows are rolling calendar days, measured on realised P&L in the ledger (fees, sales and dividends).

const pct = z.number().min(0.1).max(50);
const days = z.number().int().min(1).max(30);
export const protectionRules = z.object({
  /** Pause new buys while the bot's realised loss over the last 1 / 7 / 30 days is at least this share of its budget. */
  dailyLossPct: pct.nullable().default(null),
  weeklyLossPct: pct.nullable().default(null),
  monthlyLossPct: pct.nullable().default(null),
  /** Pause new buys for `pauseDays` after `inARow` losing exits in a row. */
  losingExits: z.object({ inARow: z.number().int().min(2).max(10), pauseDays: days }).strict().nullable().default(null),
  /** No new buy of a share for this many days after the bot sold it. */
  shareCooldownDays: days.nullable().default(null),
}).strict();
const policySchema = z.object({ rules: protectionRules, reason: z.string().trim().min(1).max(600) }).strict();
const statusSchema = z.object({ botId: id.optional() }).strict();
export type ProtectionRules = z.infer<typeof protectionRules>;
const WINDOWS = [['dailyLossPct', 1, 'protection-daily-loss'], ['weeklyLossPct', 7, 'protection-weekly-loss'],
  ['monthlyLossPct', 30, 'protection-monthly-loss']] as const;
const DAY_MS = 86_400_000;

export async function currentProtections(tx: Sql) {
  const row = (await tx.query('SELECT id,rules,reason,set_by,sequence,created_at FROM protection_policies ORDER BY sequence DESC LIMIT 1')).rows[0];
  return row ? { id: String(row.id), sequence: Number(row.sequence), rules: parse(protectionRules, row.rules), reason: row.reason as string,
    setBy: row.set_by as string, setAt: new Date(row.created_at).toISOString() } : null;
}

/** A bot's realised loss (positive = loss) over the `days` days up to `now` (an injectable clock), from the ledger. */
async function realisedLoss(tx: Sql, botId: string, windowDays: number, now: number) {
  return BigInt((await tx.query(`SELECT COALESCE(SUM(e.amount),0)::text AS value FROM entries e JOIN journals j ON j.id=e.journal_id
    WHERE e.account='PNL' AND j.kind IN ('paper-buy','paper-sell','paper-dividend') AND j.metadata->>'botId'=$1
      AND j.created_at > $3::timestamptz - ($2::int * interval '1 day') AND j.created_at <= $3::timestamptz`,
    [botId, windowDays, new Date(now).toISOString()])).rows[0]!.value);
}

export type Pause = { code: string; detail: string; until: string | null };

/** The pauses holding a bot's new buys of `symbol` now (empty when none, or with no policy). */
export async function activePauses(tx: Sql, botId: string, symbol: string | null = null, now = Date.now()): Promise<Pause[]> {
  const policy = await currentProtections(tx);
  if (!policy) return [];
  const r = policy.rules, out: Pause[] = [];
  const budget = BigInt((await tx.query('SELECT budget_paise::text AS b FROM bots WHERE id=$1', [botId])).rows[0]?.b ?? '0');
  for (const [field, windowDays, code] of WINDOWS) {
    const limit = r[field];
    if (limit === null || budget <= 0n) continue;
    const loss = await realisedLoss(tx, botId, windowDays, now);
    // compare in basis points of the budget, in integers
    if (loss > 0n && loss * 10000n >= budget * BigInt(Math.round(limit * 100))) {
      out.push({ code, detail: `realised loss ${loss} paise over the last ${windowDays} day(s) is at least ${limit}% of the budget`, until: null });
    }
  }
  if (r.losingExits) {
    const exits = (await tx.query(`SELECT j.created_at, e.amount::text AS pnl FROM journals j JOIN entries e ON e.journal_id=j.id AND e.account='PNL'
      WHERE j.kind='paper-sell' AND j.metadata->>'botId'=$1 AND j.created_at <= $3::timestamptz ORDER BY j.created_at DESC, j.id DESC LIMIT $2`,
      [botId, r.losingExits.inARow, new Date(now).toISOString()])).rows;
    if (exits.length === r.losingExits.inARow && exits.every(x => BigInt(x.pnl) > 0n)) {
      const until = new Date(exits[0]!.created_at).getTime() + r.losingExits.pauseDays * DAY_MS;
      if (until > now) out.push({ code: 'protection-losing-streak', detail: `${r.losingExits.inARow} losing exits in a row`, until: new Date(until).toISOString() });
    }
  }
  if (r.shareCooldownDays && symbol) {
    const last = (await tx.query(`SELECT MAX(created_at) AS at FROM journals WHERE kind='paper-sell' AND metadata->>'botId'=$1 AND metadata->>'symbol'=$2
      AND created_at <= $3::timestamptz`, [botId, symbol, new Date(now).toISOString()])).rows[0]?.at;
    const until = last ? new Date(last).getTime() + r.shareCooldownDays * DAY_MS : 0;
    if (until > now) out.push({ code: 'protection-share-cooldown', detail: `${symbol} was sold within the last ${r.shareCooldownDays} day(s)`, until: new Date(until).toISOString() });
  }
  return out;
}

export class Protections {
  constructor(private readonly db: Database, private readonly clock: () => number = Date.now) {}

  /** Owner only, and never the standing-approvals agent: the thresholds. A new policy replaces the previous one. */
  setPolicy(actor: Actor, key: string, raw: unknown) {
    permit(actor, 'owner');
    requireThat(actor.id !== 'autonomy-policy', 'Protections are set by the owner, not by standing approvals', 403);
    const input = parse(policySchema, raw);
    return this.db.command(actor, 'protection-policy', key, input, async tx => {
      const policyId = uuid();
      await tx.query('INSERT INTO protection_policies(id,rules,reason,set_by) VALUES($1,$2::jsonb,$3,$4)', [policyId, JSON.stringify(input.rules), input.reason, actor.id]);
      await audit(tx, actor, 'protection.policy.set', policyId, { rules: input.rules, reason: input.reason });
      return { policyId, rules: input.rules };
    });
  }

  /** The policy and every paper bot's pauses now (or one bot's). */
  status(actor: Actor, raw: unknown) {
    permit(actor, 'owner', 'evaluator');
    const input = parse(statusSchema, raw);
    return this.db.transaction(async tx => {
      const bots = (await tx.query("SELECT id FROM bots WHERE state='paper' AND ($1::text IS NULL OR id=$1) ORDER BY id", [input.botId ?? null])).rows.map(b => String(b.id));
      const paused = [];
      for (const botId of bots) {
        const pauses = await activePauses(tx, botId, null, this.clock());
        if (pauses.length) paused.push({ botId, pauses });
      }
      return { policy: await currentProtections(tx), paused,
        note: 'Pauses hold new buys only and lift by themselves; a per-share cooldown shows when that share is proposed.' };
    }, false);
  }
}

type Request = { actor: Actor };
@Controller('v1')
export class ProtectionsController {
  constructor(private readonly protections: Protections) {}
  @Post('protections/policy') @Allow('owner') policy(@Req() r: Request, @Headers('idempotency-key') k: string, @Body() b: unknown) { return this.protections.setPolicy(r.actor, k ?? '', b); }
  @Post('protections/status') @Allow('owner', 'evaluator') status(@Req() r: Request, @Body() b: unknown) { return this.protections.status(r.actor, b); }
}
