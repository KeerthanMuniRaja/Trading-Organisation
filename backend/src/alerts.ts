import { Body, Controller, Get, Headers, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { Config } from './config.js';
import { Actor, digest, parse, permit, requireThat, uuid } from './core.js';
import { Database, Sql, audit } from './database.js';
import { MARK_STALE_SECONDS, curveStats, performanceCurve } from './paper-performance.js';
import { usageByBot } from './compute-usage.js';
import { LOW_SCORE, MIN_FOR_ALERT, reliability } from './source-reliability.js';
import { available, balance, tradingLoss } from './treasury.js';
import { EVALUATION_VALID_DAYS } from './bot-releases.js';
import { Allow } from './security.js';

// Owner alerts (OBS-01). A cycle (run by the owner or an evaluator worker, e.g. every few minutes) evaluates fixed rules
// over the organisation's state. A condition that newly holds raises one alert; while it keeps holding nothing new is
// raised; when it stops holding the alert resolves itself. Severity escalation (warning -> critical) is a new condition.
// Delivery to a channel the owner chooses is done by scripts/deliver-alerts.mjs, which marks alerts delivered.
// Alerts describe; they never halt, trade, fund or retire anything.

type Condition = { rule: string; severity: 'info' | 'warning' | 'critical'; subject: string; message: string; detail: Record<string, unknown> };
// The fact-checker (integrations/claims/autolearn.py) holds single-source evidence up to holdDays (7 by default) while it
// waits for a second publisher, then decides; only evidence older than that and a day's slack is really stuck.
const BACKLOG_HOURS = 8 * 24, BACKLOG_COUNT = 20, STALE_QUOTE_SECONDS = 86_400;
const listSchema = z.object({ includeResolved: z.boolean().default(false), limit: z.number().int().min(1).max(500).default(100) }).strict();
const idsSchema = z.object({ alertIds: z.array(z.uuid()).min(1).max(100) }).strict();

export async function conditions(tx: Sql, config: Config): Promise<Condition[]> {
  const out: Condition[] = [];
  const lock = (await tx.query('SELECT halted,halt_reason FROM system_lock WHERE id=1')).rows[0]!;
  if (lock.halted) out.push({ rule: 'system-halted', severity: 'critical', subject: 'organisation',
    message: 'New risk is halted' + (lock.halt_reason ? `: ${String(lock.halt_reason).slice(0, 200)}` : '.'), detail: {} });

  let previous = 'GENESIS', broken = false;
  for (const row of (await tx.query('SELECT * FROM audit_events ORDER BY sequence')).rows) {
    const hash = digest({ id: row.id, actor: row.actor, action: row.action, entity: row.entity, payload: row.payload, previous });
    if (row.previous_hash !== previous || row.hash !== hash) { broken = true; break; }
    previous = row.hash;
  }
  if (broken) out.push({ rule: 'audit-chain-broken', severity: 'critical', subject: 'audit', message: 'The audit hash chain no longer verifies. Investigate before any further action.', detail: {} });

  const incidents = (await tx.query("SELECT id,description,severity FROM incidents WHERE status='open' ORDER BY created_at")).rows;
  for (const i of incidents) out.push(i.severity === 'critical'
    ? { rule: 'critical-incident-open', severity: 'critical', subject: String(i.id), message: 'Critical incident open: ' + String(i.description).slice(0, 200), detail: { incidentId: String(i.id) } }
    : { rule: 'incident-open', severity: 'warning', subject: String(i.id), message: 'Incident open: ' + String(i.description).slice(0, 200), detail: { incidentId: String(i.id) } });

  // PNL entries are debits: a positive balance is a net realised loss (the same rule paper trading's loss limit uses).
  const pnl = await tradingLoss(tx), loss = pnl > 0n ? pnl : 0n;
  if (config.maxLoss > 0n && loss > 0n) {
    const used = Number(loss * 100n / config.maxLoss);
    if (used >= 75) out.push({ rule: 'realised-loss-limit', severity: used >= 100 ? 'critical' : 'warning', subject: used >= 100 ? 'reached' : 'near',
      message: `Realised paper loss is ${used}% of the configured limit (${loss} of ${config.maxLoss} paise).`, detail: { lossPaise: loss.toString(), limitPaise: config.maxLoss.toString(), usedPct: used } });
  }

  const snaps = (await tx.query(`SELECT bot_id,budget_paise::text AS budget,realised_paise::text AS realised,unrealised_paise::text AS unrealised
    FROM paper_performance_snapshots WHERE day >= CURRENT_DATE - 90 ORDER BY bot_id,day`)).rows;
  const curves = new Map<string, { budget: string; realised: string; unrealised: string }[]>();
  for (const s of snaps) curves.set(s.bot_id, [...(curves.get(s.bot_id) ?? []), s as { budget: string; realised: string; unrealised: string }]);
  for (const [bot, days] of curves) {
    // a budget change is money moving, not a fall in value
    const { maxDrawdownPct } = curveStats(performanceCurve(days));
    if (maxDrawdownPct !== null && maxDrawdownPct >= 10) out.push({ rule: 'bot-drawdown', severity: maxDrawdownPct >= 20 ? 'critical' : 'warning',
      subject: bot, message: `Paper equity of ${bot} fell ${maxDrawdownPct}% from its peak in the last 90 days.`, detail: { botId: bot, maxDrawdownPct } });
  }

  const fitness = (await tx.query(`SELECT bot_id,role,baseline,verdict FROM (SELECT *,ROW_NUMBER() OVER (PARTITION BY bot_id,role,baseline
    ORDER BY created_at DESC,id DESC) AS n FROM bot_fitness_reports) r WHERE n<=2 ORDER BY bot_id,role,baseline,n`)).rows;
  const groups = new Map<string, string[]>();
  for (const f of fitness) groups.set(`${f.bot_id}|${f.role}|${f.baseline}`, [...(groups.get(`${f.bot_id}|${f.role}|${f.baseline}`) ?? []), f.verdict]);
  for (const [key, verdicts] of groups) if (verdicts.length === 2 && verdicts.every(v => v === 'worse-than-baseline')) {
    const [bot, role, baseline] = key.split('|');
    out.push({ rule: 'fitness-review', severity: 'warning', subject: `${bot}/${role}`, detail: { botId: bot, role, baseline },
      message: `${bot} (${role}) was worse than ${baseline} in its last two fitness reports: review for retraining or retirement.` });
  }

  // KNOW-02: items triaged out of scope are set aside, not waiting for anyone
  const backlog = Number((await tx.query(`SELECT COUNT(*)::int AS n FROM evidence e WHERE e.status='unverified' AND e.received_at < now() - ($1::int * interval '1 hour')
    AND NOT EXISTS (SELECT 1 FROM evidence_triage t WHERE t.evidence_id=e.id AND t.decision='out-of-scope')`,
    [BACKLOG_HOURS])).rows[0]!.n);
  if (backlog >= BACKLOG_COUNT) out.push({ rule: 'evidence-backlog', severity: 'warning', subject: 'unverified-evidence',
    message: `${backlog} pieces of evidence have waited over ${BACKLOG_HOURS / 24} days for review, longer than the fact-checker's hold period: is it running?`,
    detail: { count: backlog } });

  // priced = an approved live quote from the last day, or a verified daily close (PAPER-02) within its own tolerance
  const stale = (await tx.query(`SELECT p.bot_id,p.symbol FROM positions p LEFT JOIN quotes q ON q.symbol=p.symbol
    LEFT JOIN sources s ON s.id=q.source_id AND s.approved=true WHERE p.quantity>0 AND (s.id IS NULL OR q.observed_at < now() - ($1::int * interval '1 second'))
      AND NOT EXISTS (SELECT 1 FROM price_marks m WHERE m.symbol=p.symbol AND m.observed_at >= now() - ($2::int * interval '1 second'))
    ORDER BY p.bot_id,p.symbol`, [STALE_QUOTE_SECONDS, MARK_STALE_SECONDS])).rows;
  if (stale.length) out.push({ rule: 'stale-position-prices', severity: 'warning', subject: 'positions',
    message: `${stale.length} open paper position(s) have neither a recent approved quote nor a recent verified close; P&L for them is unreliable.`,
    detail: { positions: stale.map(p => `${p.bot_id}:${p.symbol}`).slice(0, 50) } });

  // Each bot's CURRENT active release: of the releases whose latest stage is 'active', the most recently activated one
  // (activating v2 adds no row for v1, so v1 still reads 'active'; it is a rollback target, not the running release).
  const CURRENT_ACTIVE = `SELECT DISTINCT ON (bot_id) bot_id,release_id FROM (SELECT DISTINCT ON (release_id) release_id,bot_id,stage,sequence
    FROM bot_release_stages ORDER BY release_id,sequence DESC) latest WHERE stage='active' ORDER BY bot_id,sequence DESC`;
  // SCHOOL-01: an active release whose newest evaluation has expired must be re-tested
  const staleReleases = (await tx.query(`SELECT r.id,r.bot_id,r.version,MAX(e.created_at) AS evaluated FROM bot_releases r
      JOIN (${CURRENT_ACTIVE}) st ON st.release_id=r.id
      LEFT JOIN bot_release_evaluations e ON e.release_id=r.id GROUP BY r.id,r.bot_id,r.version
      HAVING MAX(e.created_at) IS NULL OR MAX(e.created_at) < now() - ($1::int * interval '1 day')`, [EVALUATION_VALID_DAYS])).rows;
  for (const r of staleReleases) out.push({ rule: 'release-evaluation-expired', severity: 'warning', subject: `${r.bot_id}/v${r.version}`,
    message: `Active release v${r.version} of ${r.bot_id} was last evaluated more than ${EVALUATION_VALID_DAYS} days ago: re-test it on recent data.`,
    detail: { botId: r.bot_id, releaseId: String(r.id) } });

  // FITNESS-02: an active release whose newest evaluation (e.g. on live paper calls) no longer allows active use
  const failing = (await tx.query(`SELECT r.id,r.bot_id,r.version,e.fitness_verdict FROM bot_releases r
      JOIN (${CURRENT_ACTIVE}) st ON st.release_id=r.id
      JOIN (SELECT DISTINCT ON (release_id) release_id,active_eligible,fitness_verdict FROM bot_release_evaluations ORDER BY release_id,created_at DESC,id DESC) e
        ON e.release_id=r.id WHERE e.active_eligible=false ORDER BY r.bot_id`)).rows;
  for (const r of failing) out.push({ rule: 'release-failing-evaluation', severity: 'warning', subject: `${r.bot_id}/v${r.version}`,
    message: `Active release v${r.version} of ${r.bot_id} is now ${r.fitness_verdict} in its newest evaluation: owner decides whether to roll back or revoke it.`,
    detail: { botId: r.bot_id, releaseId: String(r.id), verdict: r.fitness_verdict } });

  // COST-01: department budget ceilings should be covered by capital actually available in Wallet 1
  const ceilings = BigInt((await tx.query("SELECT COALESCE(SUM(budget_paise),0)::text AS v FROM departments WHERE status='active'")).rows[0]!.v);
  const free = await available(tx);
  if (ceilings > 0n && ceilings > free) out.push({ rule: 'budgets-exceed-capital', severity: 'warning', subject: 'departments',
    message: `Active department budget ceilings total ${ceilings} paise, more than the ${free} paise available in Wallet 1.`,
    detail: { ceilingsPaise: ceilings.toString(), availablePaise: free.toString() } });

  for (const s of await reliability(tx))
    if (s.approved && s.decided >= MIN_FOR_ALERT && s.score < LOW_SCORE) out.push({ rule: 'source-low-reliability', severity: 'warning', subject: s.sourceId,
      message: `Approved source ${s.sourceId} has a reliability score of ${s.score} over ${s.decided} independent decisions: review its approval.`,
      detail: { sourceId: s.sourceId, score: s.score, decided: s.decided } });

  const budgets = (await tx.query('SELECT id,compute_tokens_per_day FROM departments WHERE status=\'active\' AND compute_tokens_per_day IS NOT NULL')).rows;
  if (budgets.length) {
    const byBot = await usageByBot(tx, 1);
    const members = new Map((await tx.query('SELECT id,department FROM bots')).rows.map(b => [b.id as string, b.department as string]));
    for (const d of budgets) {
      let used = 0n;
      for (const [bot, u] of byBot) if (members.get(bot) === d.id) used += u.tokens;
      if (used > BigInt(d.compute_tokens_per_day)) out.push({ rule: 'compute-over-budget', severity: 'warning', subject: d.id,
        message: `Department ${d.id} used ${used} model tokens in the last day, over its budget of ${d.compute_tokens_per_day}.`,
        detail: { departmentId: d.id, usedTokens: used.toString(), budgetTokensPerDay: d.compute_tokens_per_day } });
    }
  }

  if ((await tx.query("SELECT to_regclass('public.department_proposals') AS t")).rows[0]!.t) {
    const pending = Number((await tx.query(`SELECT COUNT(*)::int AS n FROM department_proposals p
      WHERE NOT EXISTS (SELECT 1 FROM department_decisions d WHERE d.proposal_id=p.id)`)).rows[0]!.n);
    if (pending) out.push({ rule: 'department-proposals-pending', severity: 'info', subject: 'departments',
      message: `${pending} department proposal(s) await the owner's decision.`, detail: { count: pending } });
  }
  return out;
}

const fingerprint = (c: Condition) => digest({ rule: c.rule, severity: c.severity, subject: c.subject });
const view = (r: Record<string, any>) => ({ id: String(r.id), rule: r.rule, severity: r.severity, subject: r.subject, message: r.message, detail: r.detail,
  raisedAt: new Date(r.raised_at).toISOString(), resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : null,
  acknowledgedAt: r.acknowledged_at ? new Date(r.acknowledged_at).toISOString() : null, deliveredAt: r.delivered_at ? new Date(r.delivered_at).toISOString() : null });

export class OwnerAlerts {
  constructor(private readonly db: Database, private readonly config: Config) {}

  cycle(actor: Actor, key: string) {
    permit(actor, 'owner', 'evaluator');
    return this.db.command(actor, 'owner-alert-cycle', key, {}, async tx => {
      const now = await conditions(tx, this.config);
      const wanted = new Map(now.map(c => [fingerprint(c), c]));
      const open = (await tx.query('SELECT id,fingerprint FROM owner_alerts WHERE resolved_at IS NULL')).rows;
      const resolved = open.filter(a => !wanted.has(a.fingerprint));
      for (const a of resolved) await tx.query('UPDATE owner_alerts SET resolved_at=now() WHERE id=$1', [a.id]);
      const known = new Set(open.map(a => a.fingerprint));
      const raised = [];
      for (const [print, c] of wanted) if (!known.has(print)) {
        const id = uuid();
        await tx.query(`INSERT INTO owner_alerts(id,rule,severity,subject,message,detail,fingerprint) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`,
          [id, c.rule, c.severity, c.subject.slice(0, 120), c.message.slice(0, 500), JSON.stringify(c.detail), print]);
        raised.push({ id, rule: c.rule, severity: c.severity, subject: c.subject });
      }
      if (raised.length || resolved.length) await audit(tx, actor, 'owner.alerts.cycle', 'alerts', { raised: raised.length, resolved: resolved.length });
      return { raised, resolved: resolved.length, open: open.length - resolved.length + raised.length };
    });
  }

  list(actor: Actor, raw: unknown) {
    permit(actor, 'owner', 'evaluator');
    const input = parse(listSchema, raw);
    return this.db.transaction(async tx => {
      const rows = (await tx.query(`SELECT * FROM owner_alerts WHERE ($1::boolean OR resolved_at IS NULL)
        ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, raised_at DESC LIMIT $2`, [input.includeResolved, input.limit])).rows.map(view);
      return { alerts: rows, open: rows.filter(a => !a.resolvedAt).length, undelivered: rows.filter(a => !a.resolvedAt && !a.deliveredAt).map(a => a.id) };
    }, false);
  }

  acknowledge(actor: Actor, key: string, raw: unknown) {
    permit(actor, 'owner');
    const input = parse(idsSchema, raw);
    return this.db.command(actor, 'owner-alert-ack', key, input, async tx => {
      const updated = (await tx.query('UPDATE owner_alerts SET acknowledged_at=COALESCE(acknowledged_at,now()) WHERE id=ANY($1::uuid[]) RETURNING id', [input.alertIds])).rows;
      requireThat(updated.length === input.alertIds.length, 'Some alerts were not found', 404);
      return { acknowledged: updated.length };
    });
  }

  /** The delivery worker reports what it delivered; delivery itself happens outside the backend. */
  delivered(actor: Actor, key: string, raw: unknown) {
    permit(actor, 'owner', 'evaluator');
    const input = parse(idsSchema, raw);
    return this.db.command(actor, 'owner-alert-delivered', key, input, async tx => {
      const updated = (await tx.query('UPDATE owner_alerts SET delivered_at=COALESCE(delivered_at,now()) WHERE id=ANY($1::uuid[]) RETURNING id', [input.alertIds])).rows;
      return { delivered: updated.length };
    });
  }
}

type Request = { actor: Actor };
@Controller('v1')
export class OwnerAlertsController {
  constructor(private readonly alerts: OwnerAlerts) {}
  @Post('alerts/cycles') @Allow('owner', 'evaluator') cycle(@Req() r: Request, @Headers('idempotency-key') k: string) { return this.alerts.cycle(r.actor, k ?? ''); }
  @Post('alerts/query') @Allow('owner', 'evaluator') list(@Req() r: Request, @Body() b: unknown) { return this.alerts.list(r.actor, b); }
  @Post('alerts/acknowledgments') @Allow('owner') ack(@Req() r: Request, @Headers('idempotency-key') k: string, @Body() b: unknown) { return this.alerts.acknowledge(r.actor, k ?? '', b); }
  @Post('alerts/deliveries') @Allow('owner', 'evaluator') delivered(@Req() r: Request, @Headers('idempotency-key') k: string, @Body() b: unknown) { return this.alerts.delivered(r.actor, k ?? '', b); }
}
