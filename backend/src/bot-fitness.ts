import { Body, Controller, Headers, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { Actor, digest, id, parse, permit, requireThat, uuid } from './core.js';
import { Database, audit } from './database.js';
import { Allow } from './security.js';

// Role-specific fitness (FITNESS-01): each report compares a bot with the do-nothing version of its own job on the
// same data (an analyst against always-neutral, a manager against always-hold, an allocator against the basket).
// Only the meetings where bot and baseline disagree carry information, so the evaluator submits the counts and the
// backend computes the exact one-sided sign test and the verdict itself; a submitter cannot choose its verdict.
// Reports are append-only and independent of the evidence author. They produce recommendations for owner and
// lifecycle review, never automatic promotion, retirement or budget changes.

export const MIN_DISAGREEMENTS = 20;
export const SIGNIFICANCE = 0.05;
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => !Number.isNaN(Date.parse(v + 'T00:00:00Z')), 'Invalid date');
const count = z.number().int().min(0).max(1_000_000);
const reportSchema = z.object({
  botId: id, role: z.string().trim().min(1).max(60).regex(/^[a-z0-9-]+$/),
  baseline: z.enum(['always-neutral', 'always-hold', 'buy-and-hold', 'cash', 'equal-weight-basket']),
  testName: z.string().trim().min(1).max(120), periodFrom: day, periodTo: day,
  judged: count.min(1), wins: count, losses: count, failed: count.default(0),
  model: z.string().trim().min(1).max(120).optional(), evidenceId: z.uuid().optional(),
}).strict()
  .refine(v => v.wins + v.losses <= v.judged, 'Wins and losses cannot exceed judged decisions')
  .refine(v => v.periodFrom <= v.periodTo, 'Period must start before it ends');
const querySchema = z.object({ botId: id, limit: z.number().int().min(1).max(100).default(50) }).strict();

/** One-sided exact binomial tail: P(X >= k) for X ~ Binomial(n, 1/2), computed in log space. */
export function signTestTail(k: number, n: number): number {
  if (n === 0 || k <= 0) return 1;
  if (k > n) return 0;
  let logC = 0;
  const logs: number[] = [];
  for (let i = 0; i <= n; i++) {
    if (i > 0) logC += Math.log((n - i + 1) / i);
    if (i >= k) logs.push(logC - n * Math.LN2);
  }
  const max = Math.max(...logs);
  return Math.min(1, Math.exp(max) * logs.reduce((s, v) => s + Math.exp(v - max), 0));
}

/** p-value for the side the bot leans to (wins over the baseline, or losses to it) and the resulting verdict. */
export function judge(wins: number, losses: number) {
  const n = wins + losses;
  const p = wins === losses ? 1 : signTestTail(Math.max(wins, losses), n);
  if (n < MIN_DISAGREEMENTS) return { pValue: p, verdict: 'insufficient-evidence' as const };
  if (wins > losses && p < SIGNIFICANCE) return { pValue: p, verdict: 'adds-value' as const };
  if (losses > wins && p < SIGNIFICANCE) return { pValue: p, verdict: 'worse-than-baseline' as const };
  return { pValue: p, verdict: 'no-detectable-skill' as const };
}

type Row = Record<string, any>;
function view(r: Row) {
  return { id: String(r.id), botId: r.bot_id, role: r.role, baseline: r.baseline, testName: r.test_name,
    periodFrom: r.period_from_day, periodTo: r.period_to_day, judged: r.judged, wins: r.wins, losses: r.losses, failed: r.failed,
    pValue: Number(Number(r.p_value).toFixed(6)), verdict: r.verdict, model: r.model ?? null,
    evidenceId: r.evidence_id ? String(r.evidence_id) : null, author: r.author, createdAt: new Date(r.created_at).toISOString() };
}
type Report = ReturnType<typeof view>;

/** From the latest two reports for one role and baseline: what deserves the owner's or lifecycle's attention. */
export function recommend(newestFirst: Report[]) {
  const [latest, previous] = newestFirst;
  if (!latest) return 'no-reports';
  if (latest.verdict === 'worse-than-baseline' && previous?.verdict === 'worse-than-baseline') return 'review-for-retraining-or-retirement';
  if (latest.verdict === 'adds-value' && previous?.verdict !== 'worse-than-baseline') return 'candidate-for-more-responsibility';
  if (latest.verdict === 'insufficient-evidence') return 'collect-more-evidence';
  return 'keep-observing';
}

export class BotFitness {
  constructor(private readonly db: Database) {}

  report(actor: Actor, key: string, raw: unknown) {
    permit(actor, 'owner', 'evaluator');
    const input = parse(reportSchema, raw);
    return this.db.command(actor, 'bot-fitness-report', key, input, async tx => {
      requireThat(!(await tx.query('SELECT halted FROM system_lock WHERE id=1')).rows[0]!.halted, 'System halted');
      const bot = (await tx.query('SELECT state FROM bots WHERE id=$1', [input.botId])).rows[0];
      requireThat(bot, 'Bot not found', 404);
      requireThat(bot.state !== 'retired', 'Retired bots keep their history but receive no new fitness reports');
      requireThat(input.periodTo <= new Date().toISOString().slice(0, 10), 'A fitness period cannot end in the future', 400);
      if (input.evidenceId) {
        const e = (await tx.query(`SELECT e.status,e.author,s.approved FROM evidence e JOIN sources s ON s.id=e.source_id WHERE e.id=$1`,
          [input.evidenceId])).rows[0];
        requireThat(e, 'Evidence not found', 404);
        requireThat(e.status === 'verified' && e.approved === true, 'Fitness evidence must be verified and from an approved source');
        requireThat(e.author !== actor.id, 'Independent fitness review required: the reporter cannot be the evidence author', 403);
      }
      const hash = digest({ ...input, failed: input.failed });
      const old = (await tx.query('SELECT id,verdict FROM bot_fitness_reports WHERE content_hash=$1', [hash])).rows[0];
      if (old) return { id: String(old.id), verdict: old.verdict, duplicate: true };
      const { pValue, verdict } = judge(input.wins, input.losses);
      const reportId = uuid();
      await tx.query(`INSERT INTO bot_fitness_reports(id,bot_id,role,baseline,test_name,period_from,period_to,judged,wins,losses,failed,
        p_value,verdict,model,evidence_id,author,content_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [reportId, input.botId, input.role, input.baseline, input.testName, input.periodFrom, input.periodTo, input.judged, input.wins,
          input.losses, input.failed, pValue, verdict, input.model ?? null, input.evidenceId ?? null, actor.id, hash]);
      await audit(tx, actor, 'bot.fitness.reported', reportId, { botId: input.botId, role: input.role, baseline: input.baseline, verdict });
      return { id: reportId, verdict, pValue: Number(pValue.toFixed(6)), duplicate: false };
    });
  }

  query(actor: Actor, raw: unknown) {
    permit(actor, 'owner', 'researcher', 'evaluator');
    const input = parse(querySchema, raw);
    return this.db.transaction(async tx => {
      const rows = (await tx.query(`SELECT *,to_char(period_from,'YYYY-MM-DD') AS period_from_day,to_char(period_to,'YYYY-MM-DD') AS period_to_day
        FROM bot_fitness_reports WHERE bot_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2`, [input.botId, input.limit])).rows.map(view);
      const groups = new Map<string, Report[]>();
      for (const r of rows) groups.set(`${r.role}|${r.baseline}`, [...(groups.get(`${r.role}|${r.baseline}`) ?? []), r]);
      const summary = [...groups.entries()].map(([key, reports]) => {
        const [role, baseline] = key.split('|');
        return { role, baseline, latestVerdict: reports[0]!.verdict, reports: reports.length, recommendation: recommend(reports) };
      });
      return { botId: input.botId, summary, reports: rows,
        note: 'Recommendations only: fitness reports never promote, retire or fund a bot. Those remain owner and lifecycle decisions.' };
    }, false);
  }
}

type Request = { actor: Actor };
@Controller('v1')
export class BotFitnessController {
  constructor(private readonly fitness: BotFitness) {}
  @Post('bots/fitness') @Allow('owner', 'evaluator') report(@Req() r: Request, @Headers('idempotency-key') k: string, @Body() b: unknown) { return this.fitness.report(r.actor, k ?? '', b); }
  @Post('bots/fitness/query') @Allow('owner', 'researcher', 'evaluator') query(@Req() r: Request, @Body() b: unknown) { return this.fitness.query(r.actor, b); }
}
