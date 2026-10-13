import { Body, Controller, Headers, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { Actor, digest, id, parse, permit, requireThat, uuid } from './core.js';
import { Database, Sql, audit } from './database.js';
import { Allow } from './security.js';

// Compute accounting (COST-01). Two sources of model usage are combined per bot and department:
//   - compute_usage: reported by research workers (trading desk, allocator, claims runs) from their own decision logs;
//   - inference_reports: the backend's own model tickets, attributed to a bot when the frozen request context names one
//     (knowledge transfer, source lessons), otherwise counted as 'unattributed'.
// The owner may set a daily token budget per department; the report flags departments over it. Nothing is throttled
// here: budgets inform the owner and alerts, while model access limits stay where they are enforced today.

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => !Number.isNaN(Date.parse(v + 'T00:00:00Z')), 'Invalid date');
const reportSchema = z.object({ botId: id, model: z.string().trim().min(1).max(120), runLabel: z.string().trim().min(1).max(160),
  periodFrom: day, periodTo: day, calls: z.number().int().min(1).max(10_000_000), promptTokens: z.number().int().min(0).max(1e12),
  completionTokens: z.number().int().min(0).max(1e12), latencyMs: z.number().int().min(0).max(1e13) }).strict()
  .refine(v => v.periodFrom <= v.periodTo, 'Period must start before it ends');
const budgetSchema = z.object({ departmentId: id, tokensPerDay: z.number().int().min(1000).max(100_000_000).nullable() }).strict();
const usageSchema = z.object({ days: z.number().int().min(1).max(365).default(30) }).strict();

export async function usageByBot(tx: Sql, days: number) {
  const reported = (await tx.query(`SELECT bot_id,SUM(calls)::bigint::text AS calls,SUM(prompt_tokens+completion_tokens)::text AS tokens,
      SUM(latency_ms)::text AS latency FROM compute_usage WHERE period_to >= CURRENT_DATE - $1::int GROUP BY bot_id`, [days])).rows;
  const backend = (await tx.query(`SELECT COALESCE(r.context->'bot'->>'id','unattributed') AS bot_id,COUNT(*)::text AS calls,
      COALESCE(SUM(COALESCE(i.prompt_tokens,0)+COALESCE(i.completion_tokens,0)),0)::text AS tokens,COALESCE(SUM(i.latency_ms),0)::text AS latency
    FROM inference_reports i JOIN development_requests r ON r.id=i.request_id WHERE i.created_at >= now() - ($1::int * interval '1 day')
    GROUP BY 1`, [days])).rows;
  const out = new Map<string, { calls: bigint; tokens: bigint; latencyMs: bigint }>();
  for (const r of [...reported, ...backend]) {
    const cur = out.get(r.bot_id) ?? { calls: 0n, tokens: 0n, latencyMs: 0n };
    out.set(r.bot_id, { calls: cur.calls + BigInt(r.calls), tokens: cur.tokens + BigInt(r.tokens), latencyMs: cur.latencyMs + BigInt(r.latency) });
  }
  return out;
}

export class ComputeUsage {
  constructor(private readonly db: Database) {}

  report(actor: Actor, key: string, raw: unknown) {
    permit(actor, 'researcher', 'evaluator', 'owner');
    const input = parse(reportSchema, raw);
    requireThat(input.periodTo <= new Date().toISOString().slice(0, 10), 'Usage cannot be reported for future days', 400);
    return this.db.command(actor, 'compute-usage', key, input, async tx => {
      requireThat((await tx.query('SELECT 1 FROM bots WHERE id=$1', [input.botId])).rows.length, 'Bot not found', 404);
      const hash = digest(input);
      const old = (await tx.query('SELECT id FROM compute_usage WHERE content_hash=$1', [hash])).rows[0];
      if (old) return { id: String(old.id), duplicate: true };
      const usageId = uuid();
      await tx.query(`INSERT INTO compute_usage(id,bot_id,model,run_label,period_from,period_to,calls,prompt_tokens,completion_tokens,latency_ms,reporter,content_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [usageId, input.botId, input.model, input.runLabel, input.periodFrom, input.periodTo, input.calls,
        input.promptTokens, input.completionTokens, input.latencyMs, actor.id, hash]);
      await audit(tx, actor, 'compute.usage.reported', usageId, { botId: input.botId, runLabel: input.runLabel, calls: input.calls });
      return { id: usageId, duplicate: false };
    });
  }

  setBudget(actor: Actor, key: string, raw: unknown) {
    permit(actor, 'owner');
    const input = parse(budgetSchema, raw);
    return this.db.command(actor, 'compute-budget', key, input, async tx => {
      const updated = (await tx.query('UPDATE departments SET compute_tokens_per_day=$2 WHERE id=$1 RETURNING id', [input.departmentId, input.tokensPerDay])).rows;
      requireThat(updated.length, 'Department not found', 404);
      await audit(tx, actor, 'department.compute.budget', input.departmentId, input);
      return input;
    });
  }

  usage(actor: Actor, raw: unknown) {
    permit(actor, 'owner', 'evaluator');
    const input = parse(usageSchema, raw);
    return this.db.transaction(async tx => {
      const byBot = await usageByBot(tx, input.days);
      const bots = new Map((await tx.query('SELECT id,department FROM bots')).rows.map(b => [b.id as string, b.department as string]));
      const budgets = new Map((await tx.query('SELECT id,compute_tokens_per_day FROM departments')).rows.map(d => [d.id as string, d.compute_tokens_per_day as number | null]));
      const departments = new Map<string, { tokens: bigint; calls: bigint; bots: string[] }>();
      for (const [bot, u] of byBot) {
        const dept = bots.get(bot) ?? 'unattributed';
        const cur = departments.get(dept) ?? { tokens: 0n, calls: 0n, bots: [] };
        departments.set(dept, { tokens: cur.tokens + u.tokens, calls: cur.calls + u.calls, bots: [...cur.bots, bot] });
      }
      return { days: input.days,
        departments: [...departments.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([dept, u]) => {
          const perDay = budgets.get(dept) ?? null;
          return { departmentId: dept, tokens: u.tokens.toString(), calls: u.calls.toString(), tokensPerDayAverage: Number(u.tokens / BigInt(input.days)),
            budgetTokensPerDay: perDay, overBudget: perDay !== null && u.tokens > BigInt(perDay) * BigInt(input.days), bots: u.bots.sort() };
        }),
        bots: [...byBot.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([bot, u]) => ({ botId: bot, department: bots.get(bot) ?? 'unattributed',
          calls: u.calls.toString(), tokens: u.tokens.toString(), averageLatencyMs: u.calls ? Number(u.latencyMs / u.calls) : null })),
        note: 'Tokens from worker reports and the backend\'s own model tickets. Budgets inform; they do not throttle.' };
    }, false);
  }
}

type Request = { actor: Actor };
@Controller('v1')
export class ComputeUsageController {
  constructor(private readonly compute: ComputeUsage) {}
  @Post('compute/usage/reports') @Allow('researcher', 'evaluator', 'owner') report(@Req() r: Request, @Headers('idempotency-key') k: string, @Body() b: unknown) { return this.compute.report(r.actor, k ?? '', b); }
  @Post('compute/budgets') @Allow('owner') budget(@Req() r: Request, @Headers('idempotency-key') k: string, @Body() b: unknown) { return this.compute.setBudget(r.actor, k ?? '', b); }
  @Post('compute/usage') @Allow('owner', 'evaluator') usage(@Req() r: Request, @Body() b: unknown) { return this.compute.usage(r.actor, b); }
}
