import { Body, Controller, Get, Headers, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { Actor, money, parse, permit, requireThat, uuid } from './core.js';
import { Config } from './config.js';
import { Database, Sql, audit } from './database.js';
import { Allow } from './security.js';
import { applyRecommendation } from './management.js';
import { applyBirthDecision } from './bot-births.js';
import { applyQualify, applyStage, EVALUATION_VALID_DAYS } from './bot-releases.js';
import { applyBudget } from './bot-control.js';

// Standing approvals (AUTO-03): the organisation decides and acts by itself; the owner approves and oversees. The owner
// approves CLASSES of decisions once, with limits (this policy). Every cycle the evaluator triggers `apply`, which
// carries out exactly the decisions the policy covers, acting as the identity 'autonomy-policy' so every automatic
// action is visibly the policy's, recorded with the policy that allowed it, and audited. Everything else stays on the
// owner's agenda. Never automatic, whatever the policy says: retirement (it settles knowledge transfer), departments,
// limits and permissions, the 60/40 rule, and anything that moves real money. With no policy, nothing is automatic.

const rulesSchema = z.object({
  /** Accept the management review's suspension recommendations (no new risk; exits stay allowed). */
  suspendOnRecommendation: z.boolean().default(false),
  /** Acknowledge 'watch' recommendations (they change nothing; the concern stays recorded). */
  acknowledgeWatch: z.boolean().default(false),
  /** Accept budget raises the review recommends, each at most maxPctPerChange, all automatic budget increases together
   *  at most maxTotalPaisePerMonth in a calendar month (department ceilings and the exposure limit still apply). */
  raiseBudget: z.object({ maxPctPerChange: z.number().int().min(1).max(25), maxTotalPaisePerMonth: money }).strict().nullable().default(null),
  /** Approve proposed births (each new bot starts in school with zero budget). */
  approveBirths: z.boolean().default(false),
  /** Activate releases whose newest, fresh evaluation allows activation. */
  activateReleases: z.boolean().default(false),
  /** Qualify school or college bots for paper trading on their active, freshly evaluated release. */
  qualifyBots: z.boolean().default(false),
  /** Give a qualified bot with no budget this starting budget (within the department ceiling); counts toward the
   *  monthly total of raiseBudget, so it needs raiseBudget too. */
  startingBudgetPaise: money.nullable().default(null),
  maxActionsPerRun: z.number().int().min(1).max(50).default(10),
}).strict().refine(r => r.startingBudgetPaise === null || r.raiseBudget !== null, 'A starting budget needs raiseBudget, whose monthly total also limits it');
const policySchema = z.object({ rules: rulesSchema, reason: z.string().trim().min(1).max(600) }).strict();
export type Rules = z.infer<typeof rulesSchema>;
export const AGENT: Actor = { id: 'autonomy-policy', role: 'owner' };

async function currentPolicy(tx: Sql) {
  const row = (await tx.query('SELECT id,rules,reason,set_by,sequence,created_at FROM autonomy_policies ORDER BY sequence DESC LIMIT 1')).rows[0];
  return row ? { id: String(row.id), sequence: Number(row.sequence), rules: parse(rulesSchema, row.rules), reason: row.reason as string,
    setBy: row.set_by as string, setAt: new Date(row.created_at).toISOString() } : null;
}

/** The most a bot with no budget may be given: the exposure limit, and the unallocated part of an active department's ceiling. */
async function startingRoom(tx: Sql, cfg: Config, botId: string, department: string) {
  let room = cfg.maxExposure;
  const dept = (await tx.query("SELECT budget_paise::text AS budget FROM departments WHERE id=$1 AND status='active'", [department])).rows[0];
  if (dept) {
    const others = BigInt((await tx.query("SELECT COALESCE(SUM(budget_paise),0)::text AS s FROM bots WHERE department=$1 AND id<>$2 AND state<>'retired'",
      [department, botId])).rows[0]!.s);
    const free = BigInt(dept.budget) - others;
    if (free < room) room = free;
  }
  return room > 0n ? room / 100n * 100n : 0n; // whole rupees
}

/** Budget increases made automatically this calendar month (raises and starting budgets). */
async function spentThisMonth(tx: Sql) {
  return BigInt((await tx.query(`SELECT COALESCE(SUM(amount_paise),0)::text AS s FROM autonomy_actions
    WHERE kind IN ('raise-budget','starting-budget') AND created_at >= date_trunc('month', now())`)).rows[0]!.s);
}

export class Autonomy {
  constructor(private readonly db: Database, private readonly cfg: Config) {}

  /** Owner only: the standing approvals. A new policy replaces the previous one; history is kept. */
  setPolicy(actor: Actor, key: string, raw: unknown) {
    permit(actor, 'owner');
    requireThat(actor.id !== AGENT.id, 'The policy cannot set itself', 403);
    const input = parse(policySchema, raw);
    return this.db.command(actor, 'autonomy-policy', key, input, async tx => {
      const policyId = uuid();
      await tx.query('INSERT INTO autonomy_policies(id,rules,reason,set_by) VALUES($1,$2::jsonb,$3,$4)', [policyId, JSON.stringify(input.rules), input.reason, actor.id]);
      await audit(tx, actor, 'autonomy.policy.set', policyId, { rules: input.rules, reason: input.reason });
      return { policyId, rules: input.rules };
    });
  }

  /** The evaluator's trigger, once per cycle: carries out what the standing approvals cover. Each decision is tried on its
   *  own (a savepoint), so one that the rules refuse is left for the owner without undoing the others. */
  apply(actor: Actor, key: string) {
    permit(actor, 'evaluator');
    return this.db.command(actor, 'autonomy-apply', key, {}, async tx => {
      if ((await tx.query('SELECT halted FROM system_lock WHERE id=1')).rows[0]!.halted) return { status: 'halted', actions: [] };
      const policy = await currentPolicy(tx);
      if (!policy) return { status: 'no-policy', actions: [] };
      const r = policy.rules, actions: Record<string, unknown>[] = [], left: Record<string, unknown>[] = [];
      const note = `Standing approval (policy ${policy.sequence}, set by ${policy.setBy})`;
      let budget = await spentThisMonth(tx);
      const room = (amount: bigint) => r.raiseBudget !== null && budget + amount <= BigInt(r.raiseBudget.maxTotalPaisePerMonth);
      const attempt = async (kind: string, target: string, amount: bigint | null, run: () => Promise<unknown>) => {
        if (actions.length >= r.maxActionsPerRun) { left.push({ kind, target, reason: 'action limit for this run reached' }); return; }
        await tx.query('SAVEPOINT autonomy_step');
        try {
          const result = await run();
          await tx.query('INSERT INTO autonomy_actions(id,policy_id,kind,target,amount_paise,detail) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
            [uuid(), policy.id, kind, target, amount?.toString() ?? null, JSON.stringify(result ?? {})]);
          await audit(tx, AGENT, 'autonomy.applied', target, { kind, policySequence: policy.sequence, amountPaise: amount?.toString() ?? null });
          await tx.query('RELEASE SAVEPOINT autonomy_step');
          if (amount) budget += amount;
          actions.push({ kind, target, ...(amount ? { amountPaise: amount.toString() } : {}) });
        } catch (error) {
          await tx.query('ROLLBACK TO SAVEPOINT autonomy_step');
          left.push({ kind, target, reason: String((error as { response?: { message?: unknown } })?.response?.message ?? (error as Error).message).slice(0, 200) });
        }
      };

      // 1. management recommendations (the newest undecided one per bot); retirement is never automatic
      const pending = (await tx.query(`SELECT r.id,r.bot_id,r.kind,r.proposed_budget_paise::text AS proposed,b.budget_paise::text AS budget
        FROM (SELECT DISTINCT ON (bot_id) * FROM bot_recommendations ORDER BY bot_id,sequence DESC) r JOIN bots b ON b.id=r.bot_id
        WHERE NOT EXISTS (SELECT 1 FROM bot_recommendation_decisions d WHERE d.recommendation_id=r.id) ORDER BY r.sequence`)).rows;
      for (const p of pending) {
        const decide = () => applyRecommendation(tx, AGENT, this.cfg, { recommendationId: String(p.id), outcome: 'accepted', note });
        if (p.kind === 'suspend' && r.suspendOnRecommendation) await attempt('suspend', p.bot_id, null, decide);
        else if (p.kind === 'watch' && r.acknowledgeWatch) await attempt('watch', p.bot_id, null, decide);
        else if (p.kind === 'raise-budget' && r.raiseBudget) {
          const before = BigInt(p.budget), increase = BigInt(p.proposed) - before;
          if (before > 0n && increase * 100n > before * BigInt(r.raiseBudget.maxPctPerChange)) left.push({ kind: 'raise-budget', target: p.bot_id, reason: 'larger than the policy allows per change' });
          else if (!room(increase)) left.push({ kind: 'raise-budget', target: p.bot_id, reason: 'over the policy\'s monthly total' });
          else await attempt('raise-budget', p.bot_id, increase, decide);
        }
      }
      // 2. births (zero budget, in school: no risk until qualified and funded)
      if (r.approveBirths) for (const b of (await tx.query(`SELECT id,bot_id FROM bot_birth_proposals p
          WHERE NOT EXISTS (SELECT 1 FROM bot_birth_decisions d WHERE d.proposal_id=p.id) ORDER BY created_at`)).rows)
        await attempt('birth', b.bot_id, null, () => applyBirthDecision(tx, AGENT, { proposalId: String(b.id), outcome: 'approved', note }));
      // 3. releases whose newest, fresh evaluation allows activation (applyStage re-checks it)
      if (r.activateReleases) for (const rel of (await tx.query(`SELECT r.id,r.bot_id,
            (SELECT stage FROM bot_release_stages s WHERE s.release_id=r.id ORDER BY sequence DESC LIMIT 1) AS stage
          FROM bot_releases r JOIN bots b ON b.id=r.bot_id
          JOIN LATERAL (SELECT active_eligible,created_at FROM bot_release_evaluations WHERE release_id=r.id ORDER BY created_at DESC,id DESC LIMIT 1) e ON true
          WHERE b.state<>'retired' AND e.active_eligible AND e.created_at >= now()-($1::int * interval '1 day') ORDER BY r.bot_id,r.version`,
          [EVALUATION_VALID_DAYS])).rows.filter(x => x.stage !== 'active' && x.stage !== 'revoked'))
        await attempt('release', rel.bot_id, null, () => applyStage(tx, AGENT, { releaseId: String(rel.id), stage: 'active', reason: note }));
      // 4. qualification on the active release (applyQualify re-checks it)
      if (r.qualifyBots) for (const b of (await tx.query(`SELECT id FROM bots WHERE state IN ('school','college') AND lifecycle_managed=false ORDER BY id`)).rows) {
        const live = (await tx.query("SELECT 1 FROM bot_release_stages WHERE bot_id=$1 AND stage='active' LIMIT 1", [b.id])).rows.length;
        if (live) await attempt('qualification', b.id, null, () => applyQualify(tx, AGENT, { botId: b.id, reason: note }));
      }
      // 5. a starting budget for a qualified bot that has none (within the department ceiling and the monthly total)
      if (r.startingBudgetPaise !== null) for (const b of (await tx.query(`SELECT id,department FROM bots WHERE state='paper' AND budget_paise=0 AND lifecycle_managed=false ORDER BY id`)).rows) {
        const ceiling = await startingRoom(tx, this.cfg, b.id, b.department);
        const amount = ceiling < BigInt(r.startingBudgetPaise) ? ceiling : BigInt(r.startingBudgetPaise);
        if (amount <= 0n) left.push({ kind: 'starting-budget', target: b.id, reason: 'no room under the department ceiling or exposure limit' });
        else if (!room(amount)) left.push({ kind: 'starting-budget', target: b.id, reason: 'over the policy\'s monthly total' });
        else await attempt('starting-budget', b.id, amount, () => applyBudget(tx, AGENT, b.id, amount.toString(), note));
      }
      return { status: 'applied', policySequence: policy.sequence, actions, leftForOwner: left };
    });
  }

  view(actor: Actor) {
    permit(actor, 'owner', 'evaluator');
    return this.db.transaction(async tx => ({
      policy: await currentPolicy(tx), automaticBudgetThisMonthPaise: (await spentThisMonth(tx)).toString(),
      recent: (await tx.query(`SELECT a.kind,a.target,a.amount_paise::text AS amount,a.created_at,p.sequence FROM autonomy_actions a
        JOIN autonomy_policies p ON p.id=a.policy_id ORDER BY a.created_at DESC LIMIT 50`)).rows
        .map(a => ({ kind: a.kind, target: a.target, amountPaise: a.amount, policySequence: Number(a.sequence), at: new Date(a.created_at).toISOString() })),
      note: 'Standing approvals: agents carry out these classes of decision; everything else waits on the owner agenda.' }), false);
  }
}

type Request = { actor: Actor };
@Controller('v1')
export class AutonomyController {
  constructor(private readonly autonomy: Autonomy) {}
  @Post('autonomy/policy') @Allow('owner') policy(@Req() r: Request, @Headers('idempotency-key') k: string, @Body() b: unknown) { return this.autonomy.setPolicy(r.actor, k ?? '', b); }
  @Post('autonomy/apply') @Allow('evaluator') apply(@Req() r: Request, @Headers('idempotency-key') k: string) { return this.autonomy.apply(r.actor, k ?? ''); }
  @Get('autonomy') @Allow('owner', 'evaluator') view(@Req() r: Request) { return this.autonomy.view(r.actor); }
}
