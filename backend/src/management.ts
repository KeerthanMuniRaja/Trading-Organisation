import { Body, Controller, Get, Headers, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { Actor, digest, parse, permit, requireThat, uuid } from './core.js';
import { Config } from './config.js';
import { Database, Sql, audit } from './database.js';
import { Allow } from './security.js';
import { compare, compute, curveStats, indiaDay } from './paper-performance.js';
import { applyBudget, applySuspension, isSuspended } from './bot-control.js';
import { EVALUATION_VALID_DAYS } from './bot-releases.js';

// Management (ORG-02). The organisation is run like a firm: every working bot's record is reviewed each day by fixed,
// published rules (management-v1), the way a manager reviews staff, and each concern becomes a recommendation for the
// owner. Nothing here acts by itself: the owner accepts or declines, and accepting applies the change in the same
// transaction. The owner's agenda gathers every decision waiting on the owner in one place: management recommendations,
// proposed births and departments, releases ready to activate, and bots ready to start paper trading.

export const RULES = 'management-v1';
export const LIMITS = {
  suspendLossPct: -15,      // return on budget at or below this: suspend (no new risk; exits stay allowed)
  watchLossPct: -8,         // return on budget at or below this: watch
  watchDrawdownPct: 20,     // worst fall of the equity curve at or above this: watch
  lapsedToWatch: 3,         // accepted proposals that lapsed in 30 days, with nothing executed: watch
  retireAfterSuspendedDays: 30,
  raiseAfterDays: 60,       // daily snapshots needed before a budget raise is considered
  raisePct: 25,
  budgetQuietDays: 90,      // no raise within this many days of the last budget change
  repeatAfterDecisionDays: 30, // a decided recommendation of the same kind is not repeated sooner
};
const decisionSchema = z.object({ recommendationId: z.uuid(), outcome: z.enum(['accepted', 'declined']), note: z.string().trim().min(1).max(600) }).strict();

type Facts = { suspended: boolean; suspendedDays: number | null; liveVerdict: string | null; livePValue: number | null; liveJudged: number;
  returnOnBudgetPct: number | null; maxDrawdownPct: number | null; snapshotDays: number; excessOverBasketPct: number | null;
  lapsed30: number; executed30: number; openPositions: number; budgetPaise: string; daysSinceBudgetChange: number | null };
type Recommendation = { kind: 'watch' | 'suspend' | 'raise-budget' | 'retire'; rule: string; reason: string; proposedBudgetPaise?: string };

/** management-v1: the first matching rule decides; null when nothing needs the owner. Pure, so it is tested directly. */
export function assess(f: Facts, raiseTo: bigint | null): Recommendation | null {
  if (f.suspended) {
    if (f.liveVerdict === 'worse-than-baseline' && (f.suspendedDays ?? 0) >= LIMITS.retireAfterSuspendedDays && f.openPositions === 0)
      return { kind: 'retire', rule: 'suspended-and-still-worse', reason: `Suspended ${f.suspendedDays} days, holds nothing, and its live calls still lose to holding cash (p=${f.livePValue}).` };
    return null;
  }
  if (f.liveVerdict === 'worse-than-baseline')
    return { kind: 'suspend', rule: 'live-worse-than-cash', reason: `Its live paper calls lose to holding cash, significantly (${f.liveJudged} calls, p=${f.livePValue}).` };
  if (f.returnOnBudgetPct !== null && f.returnOnBudgetPct <= LIMITS.suspendLossPct)
    return { kind: 'suspend', rule: 'loss-limit', reason: `It has lost ${-f.returnOnBudgetPct}% of its budget (limit ${-LIMITS.suspendLossPct}%).` };
  if (f.returnOnBudgetPct !== null && f.returnOnBudgetPct <= LIMITS.watchLossPct)
    return { kind: 'watch', rule: 'losing', reason: `It has lost ${-f.returnOnBudgetPct}% of its budget.` };
  if (f.maxDrawdownPct !== null && f.maxDrawdownPct >= LIMITS.watchDrawdownPct)
    return { kind: 'watch', rule: 'deep-drawdown', reason: `Its equity fell ${f.maxDrawdownPct}% from a peak.` };
  if (f.lapsed30 >= LIMITS.lapsedToWatch && f.executed30 === 0)
    return { kind: 'watch', rule: 'not-executing', reason: `${f.lapsed30} accepted proposals lapsed in 30 days and none was executed: check its pipeline.` };
  if (f.liveVerdict === 'adds-value' && (f.excessOverBasketPct ?? 0) > 0 && f.snapshotDays >= LIMITS.raiseAfterDays && (f.returnOnBudgetPct ?? 0) > 0
    && (f.daysSinceBudgetChange === null || f.daysSinceBudgetChange >= LIMITS.budgetQuietDays) && raiseTo !== null && raiseTo > BigInt(f.budgetPaise))
    return { kind: 'raise-budget', rule: 'proven-skill', proposedBudgetPaise: raiseTo.toString(),
      reason: `Its live calls beat cash significantly (p=${f.livePValue}), it is ${f.excessOverBasketPct}% ahead of the basket over ${f.snapshotDays} days and up ${f.returnOnBudgetPct}% on its budget.` };
  return null;
}

const daysSince = (at: unknown) => at ? Math.floor((Date.now() - new Date(at as string).getTime()) / 86_400_000) : null;

/** The largest budget a raise may propose: +raisePct, within the department's unallocated ceiling and the exposure limit. */
async function raiseCeiling(tx: Sql, cfg: Config, botId: string, department: string, budget: bigint) {
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
  const curve = (await tx.query(`SELECT (budget_paise+realised_paise+unrealised_paise)::text AS e FROM paper_performance_snapshots WHERE bot_id=$1 ORDER BY day`,
    [bot.id])).rows.map(r => BigInt(r.e));
  const flow = (await tx.query(`SELECT
      (SELECT COUNT(*)::int FROM trade_signal_lapses l JOIN trade_signals s ON s.id=l.signal_id WHERE s.bot_id=$1 AND l.created_at > now()-interval '30 days') AS lapsed,
      (SELECT COUNT(*)::int FROM trade_signal_executions x JOIN trade_signals s ON s.id=x.signal_id WHERE s.bot_id=$1 AND x.created_at > now()-interval '30 days') AS executed,
      (SELECT created_at FROM bot_suspensions WHERE bot_id=$1 ORDER BY sequence DESC LIMIT 1) AS suspended_at,
      (SELECT MAX(created_at) FROM bot_budget_changes WHERE bot_id=$1) AS budget_changed_at`, [bot.id])).rows[0]!;
  const suspended = await isSuspended(tx, bot.id), p = perf.get(bot.id);
  return { suspended, suspendedDays: suspended ? daysSince(flow.suspended_at) : null,
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
    return this.db.command(actor, 'management-decision', key, input, async tx => {
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
          const ceiling = await raiseCeiling(tx, this.cfg, r.bot_id, bot.department, budget);
          requireThat(ceiling !== null && ceiling >= BigInt(r.proposed_budget_paise), 'The department ceiling or exposure limit no longer allows this budget');
          applied = await applyBudget(tx, actor, r.bot_id, String(r.proposed_budget_paise), 'Management recommendation accepted: ' + r.reason.slice(0, 500));
        } else if (r.kind === 'retire')
          // retirement settles knowledge transfer first (POST /v1/bots/retirements); this records that it was the owner's call
          requireThat(bot.state === 'retired', 'Retire the bot first (POST /v1/bots/retirements, transferring its verified lessons), then accept');
      }
      await tx.query('INSERT INTO bot_recommendation_decisions(recommendation_id,outcome,note,decided_by) VALUES($1,$2,$3,$4)',
        [r.id, input.outcome, input.note, actor.id]);
      await audit(tx, actor, 'bot.recommendation.decided', String(r.id), { botId: r.bot_id, kind: r.kind, outcome: input.outcome });
      return { recommendationId: String(r.id), botId: r.bot_id, kind: r.kind, outcome: input.outcome, applied };
    });
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
      const items = [
        ...recommendations.filter(r => !decided.has(String(r.id))).map(r => ({ type: 'recommendation', ...view(r),
          action: `management decision: accept to ${r.kind === 'raise-budget' ? `raise the budget to ${r.proposed_budget_paise} paise` : r.kind}` })),
        ...births.map(p => ({ type: 'birth', id: String(p.id), botId: p.bot_id, name: p.name, department: p.department, specialty: p.specialty,
          contribution: p.contribution, opportunity: p.opportunity, proposer: p.proposer, action: 'approve to create the bot in school with zero budget' })),
        ...departments.map(p => ({ type: 'department', id: String(p.id), kind: p.kind, departmentId: p.department_id, name: p.name, rationale: p.rationale,
          proposer: p.proposer, action: p.kind === 'open' ? 'approve with a budget ceiling to open it' : 'approve to close it' })),
        ...ready.map(r => ({ type: 'release', id: String(r.id), botId: r.bot_id, version: r.version, model: r.model, fitnessVerdict: r.fitness_verdict,
          action: `activate release v${r.version}` })),
        ...qualify.map(b => ({ type: 'qualification', id: b.id, botId: b.id, action: 'qualify for paper trading on its active release' })),
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

type Request = { actor: Actor };
@Controller('v1')
export class ManagementController {
  constructor(private readonly management: Management) {}
  @Post('management/reviews') @Allow('evaluator') review(@Req() r: Request, @Headers('idempotency-key') k: string) { return this.management.review(r.actor, k ?? ''); }
  @Post('management/decisions') @Allow('owner') decide(@Req() r: Request, @Headers('idempotency-key') k: string, @Body() b: unknown) { return this.management.decide(r.actor, k ?? '', b); }
  @Get('management/recommendations') @Allow('owner', 'evaluator') history(@Req() r: Request) { return this.management.history(r.actor); }
  @Get('organisation/agenda') @Allow('owner') agenda(@Req() r: Request) { return this.management.agenda(r.actor); }
}
