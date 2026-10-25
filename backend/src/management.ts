import { Body, Controller, Get, Headers, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { Actor, digest, parse, permit, requireThat, uuid } from './core.js';
import { Config } from './config.js';
import { Database, Sql, audit } from './database.js';
import { Allow } from './security.js';
import { compare, compute, curveStats, indiaDay, performanceCurve } from './paper-performance.js';
import { applyBudget, applySuspension, isSuspended } from './bot-control.js';
import { EVALUATION_VALID_DAYS } from './bot-releases.js';

// Management (ORG-02). The organisation is run like a firm: every working bot's record is reviewed each day by fixed,
// published rules (management-v1), the way a manager reviews staff, and each concern becomes a recommendation for the
// owner. Nothing here acts by itself: the owner accepts or declines, and accepting applies the change in the same
// transaction. The owner's agenda gathers every decision waiting on the owner in one place: management recommendations,
// proposed births and departments, releases ready to activate, and bots ready to start paper trading.

// v2 (CHARTER-01): budget follows evidence both ways; a bot that keeps trailing the basket is recommended a smaller budget
// v3: the loss limit tells a market fall from a failing bot. A bot at the limit that is still AHEAD of simply holding the
// basket is watched, not suspended: the 2020 replay suspended a bot a week into the crash while it fell less than the
// basket, and with nothing to lift a suspension it sat in cash through the whole recovery (-13.0% against +7.8%).
// A disaster is still caught by the charter's organisation stop and the .env limits.
// v4: a way back. A bot the loss limit suspended is recommended for reinstatement, with a smaller budget, once it has
// served its time, holds nothing or has recovered, and its live calls do not lose to cash. After it returns, the loss
// rules count only what it lost since then, so its old loss cannot suspend it again the next morning.
// v5: losses and falls are measured on the bot's value with budget changes taken out (paper-performance's
// performanceCurve). Under v4 a 25% budget cut read as a 25% fall and as 25 points behind the basket, and made the same
// loss a third larger as a share of the smaller budget, so one cut invited the next cut or a suspension.
export const RULES = 'management-v5';
export const LIMITS = {
  reduceAfterDays: 60,      // daily snapshots needed before a budget cut is considered
  reduceBehindPct: 3,       // points behind the basket over its record that call for a cut
  reducePct: 25,
  minBudgetPaise: 100000,   // a cut never takes a bot below Rs 1,000 (retirement is a separate, owner-level matter)
  suspendLossPct: -15,      // return on budget at or below this: suspend (no new risk; exits stay allowed)
  watchLossPct: -8,         // return on budget at or below this: watch
  watchDrawdownPct: 20,     // worst fall of the equity curve at or above this: watch
  lapsedToWatch: 3,         // accepted proposals that lapsed in 30 days, with nothing executed: watch
  retireAfterSuspendedDays: 30,
  reinstateAfterDays: 20,   // a loss-limit suspension served at least this long before reinstatement is considered
  raiseAfterDays: 60,       // daily snapshots needed before a budget raise is considered
  raisePct: 25,
  budgetQuietDays: 90,      // no raise within this many days of the last budget change
  repeatAfterDecisionDays: 30, // a decided recommendation of the same kind is not repeated sooner
};
const decisionSchema = z.object({ recommendationId: z.uuid(), outcome: z.enum(['accepted', 'declined']), note: z.string().trim().min(1).max(600) }).strict();

type Facts = { suspended: boolean; suspendedDays: number | null; liveVerdict: string | null; livePValue: number | null; liveJudged: number;
  returnOnBudgetPct: number | null; maxDrawdownPct: number | null; snapshotDays: number; excessOverBasketPct: number | null;
  lapsed30: number; executed30: number; openPositions: number; budgetPaise: string; daysSinceBudgetChange: number | null;
  /** v4: the management rule whose accepted recommendation suspended the bot (null: the owner or a rollback did) */
  suspendedRule?: string | null;
  /** v5: change in the bot's value with budget changes taken out, since its first snapshot, or since it was last
   *  resumed (null: no snapshots yet, then returnOnBudgetPct is used) */
  valueChangePct?: number | null;
  /** v5: valueChangePct counts from the bot's last resumption */
  sinceResume?: boolean };
type Recommendation = { kind: 'watch' | 'suspend' | 'raise-budget' | 'reduce-budget' | 'reinstate' | 'retire'; rule: string; reason: string; proposedBudgetPaise?: string };

/** management-v2's cut: 25% less, in whole rupees, never below the floor; null when the bot is already at or below it. */
export function reducedBudget(budgetPaise: string): bigint | null {
  const budget = BigInt(budgetPaise), floor = BigInt(LIMITS.minBudgetPaise);
  if (budget <= floor) return null;
  const cut = budget * BigInt(100 - LIMITS.reducePct) / 100n / 100n * 100n;
  return cut < floor ? floor : cut;
}

/** management-v1: the first matching rule decides; null when nothing needs the owner. Pure, so it is tested directly. */
export function assess(f: Facts, raiseTo: bigint | null): Recommendation | null {
  if (f.suspended) {
    if (f.liveVerdict === 'worse-than-baseline' && (f.suspendedDays ?? 0) >= LIMITS.retireAfterSuspendedDays && f.openPositions === 0)
      return { kind: 'retire', rule: 'suspended-and-still-worse', reason: `Suspended ${f.suspendedDays} days, holds nothing, and its live calls still lose to holding cash (p=${f.livePValue}).` };
    // v4: only a loss-limit suspension has a way back; the owner's own, and those for failing calls, stay with the owner
    const value = f.valueChangePct ?? f.returnOnBudgetPct;
    if (f.suspendedRule === 'loss-limit' && (f.suspendedDays ?? 0) >= LIMITS.reinstateAfterDays && f.liveVerdict !== 'worse-than-baseline'
      && (f.openPositions === 0 || (value !== null && value > LIMITS.suspendLossPct)))
      return { kind: 'reinstate', rule: 'suspension-served', proposedBudgetPaise: (reducedBudget(f.budgetPaise) ?? BigInt(f.budgetPaise)).toString(),
        reason: `Suspended ${f.suspendedDays} days by the loss limit; it ${f.openPositions === 0 ? 'holds nothing' : `has recovered to ${value}% of its value`}`
          + ` and its live calls do not lose to holding cash: back to work, with less money until it earns more.` };
    return null;
  }
  if (f.liveVerdict === 'worse-than-baseline')
    return { kind: 'suspend', rule: 'live-worse-than-cash', reason: `Its live paper calls lose to holding cash, significantly (${f.liveJudged} calls, p=${f.livePValue}).` };
  // v5: the loss on its value, budget changes taken out; after a reinstatement, only the loss since then counts
  const loss = f.valueChangePct ?? f.returnOnBudgetPct, since = f.sinceResume ? ' since it was reinstated' : '';
  if (loss !== null && loss <= LIMITS.suspendLossPct) {
    if (f.excessOverBasketPct !== null && f.excessOverBasketPct > 0)
      return { kind: 'watch', rule: 'market-fall', reason: `It has lost ${-loss}% of its budget${since}, but simply holding the basket lost more `
        + `(it is ${f.excessOverBasketPct} points ahead): a market fall, not the bot failing.` };
    return { kind: 'suspend', rule: 'loss-limit', reason: `It has lost ${-loss}% of its budget${since} (limit ${-LIMITS.suspendLossPct}%)`
      + (f.excessOverBasketPct === null ? ', with no basket comparison yet.' : `, and is ${-f.excessOverBasketPct} points behind simply holding the basket.`) };
  }
  if (loss !== null && loss <= LIMITS.watchLossPct)
    return { kind: 'watch', rule: 'losing', reason: `It has lost ${-loss}% of its budget${since}.` };
  if (f.maxDrawdownPct !== null && f.maxDrawdownPct >= LIMITS.watchDrawdownPct)
    return { kind: 'watch', rule: 'deep-drawdown', reason: `Its equity fell ${f.maxDrawdownPct}% from a peak.` };
  if (f.lapsed30 >= LIMITS.lapsedToWatch && f.executed30 === 0)
    return { kind: 'watch', rule: 'not-executing', reason: `${f.lapsed30} accepted proposals lapsed in 30 days and none was executed: check its pipeline.` };
  const cut = reducedBudget(f.budgetPaise);
  if (f.liveVerdict !== 'adds-value' && f.excessOverBasketPct !== null && f.excessOverBasketPct <= -LIMITS.reduceBehindPct && f.snapshotDays >= LIMITS.reduceAfterDays
    && (f.daysSinceBudgetChange === null || f.daysSinceBudgetChange >= LIMITS.budgetQuietDays) && cut !== null)
    return { kind: 'reduce-budget', rule: 'trails-basket', proposedBudgetPaise: cut.toString(),
      reason: `It is ${-f.excessOverBasketPct} points behind simply holding the basket over ${f.snapshotDays} days, without proven skill: less money until it earns more.` };
  if (f.liveVerdict === 'adds-value' && (f.excessOverBasketPct ?? 0) > 0 && f.snapshotDays >= LIMITS.raiseAfterDays && (loss ?? 0) > 0
    && (f.daysSinceBudgetChange === null || f.daysSinceBudgetChange >= LIMITS.budgetQuietDays) && raiseTo !== null && raiseTo > BigInt(f.budgetPaise))
    return { kind: 'raise-budget', rule: 'proven-skill', proposedBudgetPaise: raiseTo.toString(),
      reason: `Its live calls beat cash significantly (p=${f.livePValue}), it is ${f.excessOverBasketPct}% ahead of the basket over ${f.snapshotDays} days and its value is up ${loss}%.` };
  return null;
}

const daysSince = (at: unknown) => at ? Math.floor((Date.now() - new Date(at as string).getTime()) / 86_400_000) : null;

/** The largest budget a raise may propose: +raisePct, within the department's unallocated ceiling and the exposure limit. */
export async function raiseCeiling(tx: Sql, cfg: Config, botId: string, department: string, budget: bigint) {
  let target = budget * BigInt(100 + LIMITS.raisePct) / 100n / 100n * 100n; // whole rupees
  if (target > cfg.maxExposure) target = cfg.maxExposure;
  const dept = (await tx.query("SELECT budget_paise::text AS budget FROM departments WHERE id=$1 AND status='active'", [department])).rows[0];
  if (dept) {
    const others = BigInt((await tx.query("SELECT COALESCE(SUM(budget_paise),0)::text AS s FROM bots WHERE department=$1 AND id<>$2 AND state<>'retired'",
      [department, botId])).rows[0]!.s);
    const room = BigInt(dept.budget) - others;
    if (target > room) target = room;
  }
  return target > budget ? target : null;
}

async function facts(tx: Sql, bot: Record<string, any>, perf: Map<string, Record<string, any>>, bench: Map<string, Record<string, any>>): Promise<Facts> {
  const live = (await tx.query(`SELECT verdict,p_value,judged FROM bot_fitness_reports WHERE bot_id=$1 AND test_name LIKE 'live-paper%'
    ORDER BY created_at DESC,id DESC LIMIT 1`, [bot.id])).rows[0];
  const snaps = (await tx.query(`SELECT to_char(day,'YYYY-MM-DD') AS day,budget_paise::text AS budget,realised_paise::text AS realised,
    unrealised_paise::text AS unrealised FROM paper_performance_snapshots WHERE bot_id=$1 ORDER BY day`, [bot.id])).rows as
    { day: string; budget: string; realised: string; unrealised: string }[];
  const curve = performanceCurve(snaps);
  const flow = (await tx.query(`SELECT
      (SELECT COUNT(*)::int FROM trade_signal_lapses l JOIN trade_signals s ON s.id=l.signal_id WHERE s.bot_id=$1 AND l.created_at > now()-interval '30 days') AS lapsed,
      (SELECT COUNT(*)::int FROM trade_signal_executions x JOIN trade_signals s ON s.id=x.signal_id WHERE s.bot_id=$1 AND x.created_at > now()-interval '30 days') AS executed,
      (SELECT created_at FROM bot_suspensions WHERE bot_id=$1 ORDER BY sequence DESC LIMIT 1) AS suspended_at,
      (SELECT MAX(created_at) FROM bot_budget_changes WHERE bot_id=$1) AS budget_changed_at`, [bot.id])).rows[0]!;
  const suspended = await isSuspended(tx, bot.id), p = perf.get(bot.id);
  // v4: which rule's accepted recommendation suspended it (its decision is written in the suspension's own transaction)
  const suspendedRule = suspended ? (await tx.query(`SELECT r.rule FROM bot_recommendations r JOIN bot_recommendation_decisions d ON d.recommendation_id=r.id
      WHERE r.bot_id=$1 AND r.kind='suspend' AND d.outcome='accepted' AND abs(extract(epoch FROM d.created_at - $2::timestamptz)) < 5
      ORDER BY d.created_at DESC LIMIT 1`, [bot.id, flow.suspended_at])).rows[0]?.rule ?? null : null;
  // v5: the change in value, budget changes taken out; once resumed, from the last daily snapshot before the resumption
  // (the latest bot_suspensions row of an unsuspended bot is its resumption)
  const sinceResume = !suspended && !!flow.suspended_at;
  let from = 0;
  if (sinceResume) {
    const resumeDay = indiaDay(new Date(flow.suspended_at).getTime());
    from = Math.max(0, snaps.reduce((at, s, i) => s.day <= resumeDay ? i : at, -1)); // none before it: its first snapshot
  }
  const base = from >= 0 ? curve[from] : undefined, now = curve[curve.length - 1];
  const valueChangePct = base !== undefined && now !== undefined && base > 0n ? Number((Number((now - base) * 1_000_000n / base) / 10_000).toFixed(2))
    : sinceResume ? 0 : null; // resumed with no snapshot since: nothing lost since then
  return { suspended, suspendedDays: suspended ? daysSince(flow.suspended_at) : null, suspendedRule, valueChangePct, sinceResume,
    liveVerdict: live?.verdict ?? null, livePValue: live ? Number(Number(live.p_value).toFixed(4)) : null, liveJudged: live?.judged ?? 0,
    returnOnBudgetPct: p?.returnOnBudgetPct ?? null, maxDrawdownPct: curveStats(curve).maxDrawdownPct, snapshotDays: curve.length,
    excessOverBasketPct: bench.get(bot.id)?.excessPct ?? null, lapsed30: flow.lapsed, executed30: flow.executed,
    openPositions: p?.openPositions.length ?? 0, budgetPaise: bot.budget, daysSinceBudgetChange: daysSince(flow.budget_changed_at) };
}

function view(r: Record<string, any>) {
  return { id: String(r.id), botId: r.bot_id, kind: r.kind, rule: r.rule, reason: r.reason, proposedBudgetPaise: r.proposed_budget_paise ?? null,
    facts: r.facts, proposer: r.proposer, createdAt: new Date(r.created_at).toISOString() };
}

export class Management {
  constructor(private readonly db: Database, private readonly cfg: Config) {}

  /** The evaluator's daily review of every bot in paper trading. Files at most one recommendation per bot and day. */
  review(actor: Actor, key: string) {
    permit(actor, 'evaluator');
    return this.db.command(actor, 'management-review', key, {}, async tx => {
      requireThat(!(await tx.query('SELECT halted FROM system_lock WHERE id=1')).rows[0]!.halted, 'System halted');
      const bots = (await tx.query(`SELECT id,department,budget_paise::text AS budget FROM bots WHERE state='paper' ORDER BY id`)).rows;
      const perf = new Map((await compute(tx, null, Date.now())).map(b => [b.botId, b as Record<string, any>]));
      const bench = new Map((await compare(tx, null)).map(b => [b.botId, b as Record<string, any>]));
      const day = indiaDay(Date.now()), filed: Record<string, unknown>[] = [];
      let reviewed = 0;
      for (const bot of bots) {
        reviewed++;
        const f = await facts(tx, bot, perf, bench);
        const r = assess(f, await raiseCeiling(tx, this.cfg, bot.id, bot.department, BigInt(bot.budget)));
        if (!r) continue;
        const last = (await tx.query(`SELECT r.kind,d.outcome,d.created_at AS decided_at FROM bot_recommendations r
          LEFT JOIN bot_recommendation_decisions d ON d.recommendation_id=r.id WHERE r.bot_id=$1 ORDER BY r.sequence DESC LIMIT 1`, [bot.id])).rows[0];
        // the same concern is not repeated while it waits for the owner, nor for a while after the owner decided it
        if (last?.kind === r.kind && (!last.outcome || (daysSince(last.decided_at) ?? 0) < LIMITS.repeatAfterDecisionDays)) continue;
        const hash = digest({ botId: bot.id, kind: r.kind, rule: r.rule, day });
        if ((await tx.query('SELECT 1 FROM bot_recommendations WHERE content_hash=$1', [hash])).rows.length) continue;
        const recommendationId = uuid();
        await tx.query(`INSERT INTO bot_recommendations(id,bot_id,kind,rule,reason,proposed_budget_paise,facts,proposer,content_hash)
          VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`, [recommendationId, bot.id, r.kind, r.rule, r.reason, r.proposedBudgetPaise ?? null,
          JSON.stringify({ rules: RULES, ...f }), actor.id, hash]);
        await audit(tx, actor, 'bot.recommendation.filed', recommendationId, { botId: bot.id, kind: r.kind, rule: r.rule });
        filed.push({ id: recommendationId, botId: bot.id, kind: r.kind, rule: r.rule });
      }
      return { rules: RULES, day, reviewed, filed };
    });
  }

  /** The owner's decision. Only the newest recommendation for a bot can be decided; accepting applies it atomically. */
  decide(actor: Actor, key: string, raw: unknown) {
    permit(actor, 'owner');
    const input = parse(decisionSchema, raw);
    return this.db.command(actor, 'management-decision', key, input, tx => applyRecommendation(tx, actor, this.cfg, input));
  }

  /** Everything waiting on the owner, in one place. */
  agenda(actor: Actor) {
    permit(actor, 'owner');
    return this.db.transaction(async tx => {
      const recommendations = (await tx.query(`SELECT DISTINCT ON (r.bot_id) r.* FROM bot_recommendations r ORDER BY r.bot_id,r.sequence DESC`)).rows;
      const decided = new Set((await tx.query('SELECT recommendation_id FROM bot_recommendation_decisions')).rows.map(r => String(r.recommendation_id)));
      const births = (await tx.query(`SELECT p.id,p.bot_id,p.name,p.department,p.specialty,p.contribution,p.opportunity,p.proposer FROM bot_birth_proposals p
        WHERE NOT EXISTS (SELECT 1 FROM bot_birth_decisions d WHERE d.proposal_id=p.id) ORDER BY p.created_at`)).rows;
      const departments = (await tx.query(`SELECT p.id,p.kind,p.department_id,p.name,p.rationale,p.proposer FROM department_proposals p
        WHERE NOT EXISTS (SELECT 1 FROM department_decisions d WHERE d.proposal_id=p.id) ORDER BY p.created_at`)).rows;
      // a release is ready when its newest evaluation allows activation, is fresh, and it is not already active or revoked
      const releases = (await tx.query(`SELECT r.id,r.bot_id,r.version,r.model,e.fitness_verdict,b.state,
          (SELECT stage FROM bot_release_stages s WHERE s.release_id=r.id ORDER BY sequence DESC LIMIT 1) AS stage
        FROM bot_releases r JOIN bots b ON b.id=r.bot_id
        JOIN LATERAL (SELECT active_eligible,fitness_verdict,created_at FROM bot_release_evaluations WHERE release_id=r.id ORDER BY created_at DESC,id DESC LIMIT 1) e ON true
        WHERE b.state<>'retired' AND e.active_eligible=true AND e.created_at >= now()-($1::int * interval '1 day') ORDER BY r.bot_id,r.version`, [EVALUATION_VALID_DAYS])).rows;
      const ready = releases.filter(r => r.stage !== 'active' && r.stage !== 'revoked');
      const active = releases.filter(r => r.stage === 'active');
      const qualify = (await tx.query(`SELECT id FROM bots WHERE state IN ('school','college') AND lifecycle_managed=false ORDER BY id`)).rows
        .filter(b => active.some(r => r.bot_id === b.id));
      // a bot qualified for paper trading with no budget cannot buy anything: the owner sets how much it may use
      const unfunded = (await tx.query(`SELECT id FROM bots WHERE state='paper' AND budget_paise=0 AND lifecycle_managed=false ORDER BY id`)).rows;
      const items = [
        ...recommendations.filter(r => !decided.has(String(r.id))).map(r => ({ type: 'recommendation', ...view(r),
          action: `management decision: accept to ${r.kind === 'raise-budget' ? `raise the budget to ${r.proposed_budget_paise} paise`
            : r.kind === 'reduce-budget' ? `reduce the budget to ${r.proposed_budget_paise} paise`
            : r.kind === 'reinstate' ? `lift the suspension, with a budget of ${r.proposed_budget_paise} paise` : r.kind}` })),
        ...births.map(p => ({ type: 'birth', id: String(p.id), botId: p.bot_id, name: p.name, department: p.department, specialty: p.specialty,
          contribution: p.contribution, opportunity: p.opportunity, proposer: p.proposer, action: 'approve to create the bot in school with zero budget' })),
        ...departments.map(p => ({ type: 'department', id: String(p.id), kind: p.kind, departmentId: p.department_id, name: p.name, rationale: p.rationale,
          proposer: p.proposer, action: p.kind === 'open' ? 'approve with a budget ceiling to open it' : 'approve to close it' })),
        ...ready.map(r => ({ type: 'release', id: String(r.id), botId: r.bot_id, version: r.version, model: r.model, fitnessVerdict: r.fitness_verdict,
          action: `activate release v${r.version}` })),
        ...qualify.map(b => ({ type: 'qualification', id: b.id, botId: b.id, action: 'qualify for paper trading on its active release' })),
        ...unfunded.map(b => ({ type: 'budget', id: b.id, botId: b.id, action: 'set its budget (--budget-paise); it needs its own trader credential too (npm run bot-credential)' })),
      ];
      return { asOf: new Date().toISOString(), rules: RULES, waiting: items.length, items,
        note: 'Bots propose and the management review recommends; nothing here changes until the owner decides.' };
    }, false);
  }

  history(actor: Actor) {
    permit(actor, 'owner', 'evaluator');
    return this.db.transaction(async tx => ({ recommendations: (await tx.query(`SELECT r.*,d.outcome,d.note,d.created_at AS decided_at
      FROM bot_recommendations r LEFT JOIN bot_recommendation_decisions d ON d.recommendation_id=r.id ORDER BY r.sequence DESC LIMIT 200`)).rows
      .map(r => ({ ...view(r), outcome: r.outcome ?? 'pending', note: r.note ?? null, decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null })) }), false);
  }
}

/** Decides one recommendation inside the caller's transaction: the owner, or a standing approval acting for the owner.
 *  Only the newest recommendation for a bot can be decided; accepting applies it in the same transaction. */
export async function applyRecommendation(tx: Sql, actor: Actor, cfg: Config, input: { recommendationId: string; outcome: 'accepted' | 'declined'; note: string }) {
  const r = (await tx.query('SELECT * FROM bot_recommendations WHERE id=$1', [input.recommendationId])).rows[0];
  requireThat(r, 'Recommendation not found', 404);
  requireThat(!(await tx.query('SELECT 1 FROM bot_recommendation_decisions WHERE recommendation_id=$1', [r.id])).rows.length, 'Recommendation already decided');
  const newest = (await tx.query('SELECT id FROM bot_recommendations WHERE bot_id=$1 ORDER BY sequence DESC LIMIT 1', [r.bot_id])).rows[0]!;
  requireThat(String(newest.id) === String(r.id), 'A newer recommendation for this bot supersedes this one; decide that one');
  let applied: unknown = null;
  if (input.outcome === 'accepted') {
    const bot = (await tx.query('SELECT state,department FROM bots WHERE id=$1', [r.bot_id])).rows[0]!;
    if (r.kind === 'suspend') applied = await isSuspended(tx, r.bot_id) ? 'already suspended'
      : await applySuspension(tx, actor, r.bot_id, true, 'Management recommendation accepted: ' + r.reason.slice(0, 500));
    else if (r.kind === 'raise-budget') {
      // the ceiling is checked again now: other budgets may have changed since the review
      const budget = BigInt((await tx.query('SELECT budget_paise::text AS b FROM bots WHERE id=$1', [r.bot_id])).rows[0]!.b);
      const ceiling = await raiseCeiling(tx, cfg, r.bot_id, bot.department, budget);
      requireThat(ceiling !== null && ceiling >= BigInt(r.proposed_budget_paise), 'The department ceiling or exposure limit no longer allows this budget');
      applied = await applyBudget(tx, actor, r.bot_id, String(r.proposed_budget_paise), 'Management recommendation accepted: ' + r.reason.slice(0, 500));
    } else if (r.kind === 'reduce-budget') {
      // a cut only ever lowers the budget: if it is already at or below the proposal, nothing changes
      const budget = BigInt((await tx.query('SELECT budget_paise::text AS b FROM bots WHERE id=$1', [r.bot_id])).rows[0]!.b);
      applied = budget <= BigInt(r.proposed_budget_paise) ? 'already at or below the proposed budget'
        : await applyBudget(tx, actor, r.bot_id, String(r.proposed_budget_paise), 'Management recommendation accepted: ' + r.reason.slice(0, 500));
    } else if (r.kind === 'reinstate') {
      // the suspension lifts and the smaller budget applies together; a reinstatement never raises the budget
      const why = 'Management recommendation accepted: ' + r.reason.slice(0, 500);
      const resumed = await applySuspension(tx, actor, r.bot_id, false, why);
      const budget = BigInt((await tx.query('SELECT budget_paise::text AS b FROM bots WHERE id=$1', [r.bot_id])).rows[0]!.b);
      applied = { ...resumed, budget: budget <= BigInt(r.proposed_budget_paise) ? 'unchanged'
        : await applyBudget(tx, actor, r.bot_id, String(r.proposed_budget_paise), why) };
    } else if (r.kind === 'retire')
      // retirement settles knowledge transfer first (POST /v1/bots/retirements); this records that it was the owner's call
      requireThat(bot.state === 'retired', 'Retire the bot first (POST /v1/bots/retirements, transferring its verified lessons), then accept');
  }
  await tx.query('INSERT INTO bot_recommendation_decisions(recommendation_id,outcome,note,decided_by) VALUES($1,$2,$3,$4)',
    [r.id, input.outcome, input.note, actor.id]);
  await audit(tx, actor, 'bot.recommendation.decided', String(r.id), { botId: r.bot_id, kind: r.kind, outcome: input.outcome });
  return { recommendationId: String(r.id), botId: r.bot_id as string, kind: r.kind as string, outcome: input.outcome, applied };
}

type Request = { actor: Actor };
@Controller('v1')
export class ManagementController {
  constructor(private readonly management: Management) {}
  @Post('management/reviews') @Allow('evaluator') review(@Req() r: Request, @Headers('idempotency-key') k: string) { return this.management.review(r.actor, k ?? ''); }
  @Post('management/decisions') @Allow('owner') decide(@Req() r: Request, @Headers('idempotency-key') k: string, @Body() b: unknown) { return this.management.decide(r.actor, k ?? '', b); }
  @Get('management/recommendations') @Allow('owner', 'evaluator') history(@Req() r: Request) { return this.management.history(r.actor); }
  @Get('organisation/agenda') @Allow('owner') agenda(@Req() r: Request) { return this.management.agenda(r.actor); }
}
