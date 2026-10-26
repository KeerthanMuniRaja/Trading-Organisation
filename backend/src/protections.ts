import { Body, Controller, Headers, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { Actor, id, parse, permit, requireThat, uuid } from './core.js';
import { Database, Sql, audit } from './database.js';
import { Allow } from './security.js';
import { compute as paperPerformance, indiaDay } from './paper-performance.js';

// Self-expiring protections (PROTECT-01, from freqtrade's protections and the trading-skills circuit breaker): brakes
// that pause a bot's NEW BUYS by themselves and lift by themselves, so the organisation can run unattended without a
// person having to resume anything. Exits are never blocked, so risk can only fall while a pause holds. The owner sets
// the thresholds (a policy, owner only, never the standing-approvals agent); with no policy nothing is paused. Checked
// wherever the halt is: the risk review (a recorded reason) and the paper order's reserve and fill (a refusal).
// Windows are rolling calendar days, measured on realised P&L in the ledger (fees, sales and dividends), or on the fall in
// value with open positions included when the policy says `measure: 'equity'`.

const pct = z.number().min(0.1).max(50);
const days = z.number().int().min(1).max(30);
export const protectionRules = z.object({
  /** Pause new buys while the bot's realised loss over the last 1 / 7 / 30 days is at least this share of its budget. */
  dailyLossPct: pct.nullable().default(null),
  weeklyLossPct: pct.nullable().default(null),
  monthlyLossPct: pct.nullable().default(null),
  /** What the loss windows measure: 'realised' (sales, fees and dividends in the ledger) or 'equity' (the fall in the
   *  bot's total P&L, open positions marked now, since its recorded mark at the window's start). The 2020 replay showed
   *  realised brakes trip on a planned rebalance after the fall is over; equity brakes trip during the fall itself. */
  measure: z.enum(['realised', 'equity']).default('realised'),
  /** Pause new buys for `pauseDays` after `inARow` losing exits in a row. */
  losingExits: z.object({ inARow: z.number().int().min(2).max(10), pauseDays: days }).strict().nullable().default(null),
  /** No new buy of a share for this many days after the bot sold it. */
  shareCooldownDays: days.nullable().default(null),
  /** CHARTER-01 last-resort stop: when the organisation's total P&L (realised AND open, all bots) falls to minus this
   *  many paise, the guard halts all new risk with a critical incident and the owner is alerted. It does not lift by
   *  itself: only the owner resumes (resolve the incident, then resume operations). */
  organisationLossPaise: z.string().regex(/^[1-9][0-9]{0,13}$/).nullable().default(null),
  /** PROTECT-02 (27 Oct 2026, from Lean's sector exposure model): a bot's holdings in one sector (held, reserved and
   *  accepted-but-unexecuted buys, at cost) may not pass `maxPct` of its budget. The review sizes a buy down to the room
   *  left in its sector (reason `sized-by-sector-limit`); exits are never limited. `sectors` maps each share to its sector
   *  (NSE's industry names, from the NIFTY 500 constituent file); a share not in the map is not limited. */
  sectorLimit: z.object({ maxPct: z.number().min(5).max(100), sectors: z.record(z.string().regex(/^[A-Z0-9&_-]{1,30}$/), z.string().trim().min(1).max(80))
    .refine(m => Object.keys(m).length <= 600, 'At most 600 shares') }).strict().nullable().default(null),
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

/** A bot's fall in total P&L (positive = loss) since its snapshot at the window's start (none yet: since it began at 0). */
async function equityLoss(tx: Sql, botId: string, windowDays: number, now: number) {
  const current = (await paperPerformance(tx, botId, now))[0];
  if (!current) return 0n;
  const base = (await tx.query(`SELECT (realised_paise+unrealised_paise)::text AS total FROM paper_performance_snapshots
    WHERE bot_id=$1 AND day <= $2::date ORDER BY day DESC LIMIT 1`, [botId, indiaDay(now - windowDays * DAY_MS)])).rows[0];
  return BigInt(base?.total ?? '0') - (BigInt(current.realisedPaise) + BigInt(current.unrealisedPaise));
}

/** PROTECT-02: the sector limit that applies to a share, with every share of its sector; null when none applies. */
export async function sectorLimitFor(tx: Sql, symbol: string) {
  const limit = (await currentProtections(tx))?.rules.sectorLimit;
  const sector = limit?.sectors[symbol];
  if (!limit || !sector) return null;
  return { sector, maxPct: limit.maxPct, symbols: Object.keys(limit.sectors).filter(s => limit.sectors[s] === sector) };
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
    const loss = r.measure === 'equity' ? await equityLoss(tx, botId, windowDays, now) : await realisedLoss(tx, botId, windowDays, now);
    // compare in basis points of the budget, in integers
    if (loss > 0n && loss * 10000n >= budget * BigInt(Math.round(limit * 100))) {
      out.push({ code, detail: `${r.measure === 'equity' ? 'fall in value (open positions included)' : 'realised loss'} ${loss} paise over the last ${windowDays} day(s) is at least ${limit}% of the budget`, until: null });
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

  /** CHARTER-01, the evaluator's daily guard: the organisation's total P&L against the charter's loss limit. At or past
   *  it, one critical incident halts all new risk (exits stay allowed) and raises the owner's alert; it never resumes
   *  by itself. */
  guard(actor: Actor, key: string) {
    permit(actor, 'evaluator');
    return this.db.command(actor, 'protection-guard', key, {}, async tx => {
      const policy = await currentProtections(tx);
      const limit = policy?.rules.organisationLossPaise ? BigInt(policy.rules.organisationLossPaise) : null;
      const total = (await paperPerformance(tx, null, this.clock())).reduce((s, b) => s + BigInt(b.realisedPaise) + BigInt(b.unrealisedPaise), 0n);
      if (limit === null) return { status: 'no-limit', totalPaise: total.toString() };
      if (total > -limit) return { status: 'within', totalPaise: total.toString(), limitPaise: (-limit).toString() };
      if ((await tx.query('SELECT halted FROM system_lock WHERE id=1')).rows[0]!.halted) return { status: 'already-halted', totalPaise: total.toString() };
      const incidentId = uuid(), description = `Founder charter: the organisation's total P&L (${total} paise, open losses included) reached the `
        + `charter's loss limit (-${limit} paise). New risk is halted; exits stay allowed. Only the owner resumes.`;
      await tx.query("INSERT INTO incidents(id,reporter,description,severity,status) VALUES($1,$2,$3,'critical','open')", [incidentId, actor.id, description]);
      await tx.query('UPDATE system_lock SET halted=true,halt_reason=$1 WHERE id=1', [incidentId]);
      await audit(tx, actor, 'protection.organisation-stop', incidentId, { totalPaise: total.toString(), limitPaise: limit.toString(), policySequence: policy!.sequence });
      return { status: 'stopped', incidentId, totalPaise: total.toString(), limitPaise: (-limit).toString() };
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
  @Post('protections/guard') @Allow('evaluator') guard(@Req() r: Request, @Headers('idempotency-key') k: string) { return this.protections.guard(r.actor, k ?? ''); }
}
