import { Body, Controller, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { Actor, parse, permit } from './core.js';
import { Database } from './database.js';
import { compare as againstBasket, compute as paperPerformance } from './paper-performance.js';
import { usageByBot } from './compute-usage.js';
import { Allow } from './security.js';

// Owner digest (OBS-01): one summary of what the organisation did in a window (default the last 24 hours) and what
// needs the owner. Read-only; assembled from the ledger, proposals, evidence, alerts and pending decisions.

const schema = z.object({ hours: z.number().int().min(1).max(24 * 31).default(24) }).strict();

export class OwnerDigest {
  constructor(private readonly db: Database) {}

  digest(actor: Actor, raw: unknown) {
    permit(actor, 'owner', 'evaluator');
    const input = parse(schema, raw);
    return this.db.transaction(async tx => {
      const since = `now() - ($1::int * interval '1 hour')`, p = [input.hours];
      const one = async (sql: string, params: unknown[] = p) => (await tx.query(sql, params)).rows[0]!;
      const perf = await paperPerformance(tx, null, Date.now());
      const money = perf.reduce((m, b) => ({ realised: m.realised + BigInt(b.realisedPaise), unrealised: m.unrealised + BigInt(b.unrealisedPaise) }),
        { realised: 0n, unrealised: 0n });
      const trading = await one(`SELECT
          (SELECT COUNT(*) FROM trade_signals WHERE created_at >= ${since})::int AS proposed,
          (SELECT COUNT(*) FROM trade_signal_reviews WHERE created_at >= ${since} AND outcome='accepted')::int AS accepted,
          (SELECT COUNT(*) FROM trade_signal_reviews WHERE created_at >= ${since} AND outcome='rejected')::int AS rejected,
          (SELECT COUNT(*) FROM trade_signal_executions WHERE created_at >= ${since})::int AS executed,
          (SELECT COALESCE(SUM(realised_paise),0) FROM trade_signal_executions WHERE created_at >= ${since})::text AS realised,
          (SELECT COUNT(*) FROM trade_signal_outcomes WHERE created_at >= ${since})::int AS scored,
          (SELECT COUNT(*) FROM trade_signal_outcomes WHERE created_at >= ${since} AND correct)::int AS right,
          (SELECT COUNT(*) FROM trade_signal_challenges WHERE created_at >= ${since})::int AS challenges,
          (SELECT COUNT(*) FROM trade_signal_lapses WHERE created_at >= ${since})::int AS lapsed,
          (SELECT COALESCE(SUM(released_paise),0) FROM trade_signal_lapses WHERE created_at >= ${since})::text AS released,
          (SELECT COUNT(*) FROM corporate_actions WHERE created_at >= ${since})::int AS corporate_actions`);
      // FITNESS-02: each bot's newest verdict on its live paper calls (whatever the window)
      const live = (await tx.query(`SELECT DISTINCT ON (bot_id) bot_id,verdict,judged,wins,test_name FROM bot_fitness_reports
        WHERE test_name LIKE 'live-paper%' ORDER BY bot_id,created_at DESC,id DESC`, [])).rows
        .map(r => ({ botId: r.bot_id, verdict: r.verdict, judged: r.judged, right: r.wins, scope: String(r.test_name).slice('live-paper '.length) }));
      const knowledge = await one(`SELECT
          (SELECT COUNT(*) FROM evidence WHERE received_at >= ${since})::int AS received,
          (SELECT COUNT(*) FROM evidence WHERE reviewed_at >= ${since} AND status='verified')::int AS verified,
          (SELECT COUNT(*) FROM evidence WHERE reviewed_at >= ${since} AND status='rejected')::int AS rejected,
          (SELECT COUNT(*) FROM evidence e WHERE e.status='unverified'
            AND NOT EXISTS (SELECT 1 FROM evidence_triage t WHERE t.evidence_id=e.id AND t.decision='out-of-scope'))::int AS backlog,
          (SELECT COUNT(*) FROM evidence e JOIN evidence_triage t ON t.evidence_id=e.id
            WHERE e.status='unverified' AND t.decision='out-of-scope')::int AS "setAside"`);
      const alerts = (await tx.query(`SELECT severity,COUNT(*)::int AS n FROM owner_alerts WHERE resolved_at IS NULL GROUP BY severity`)).rows;
      const topAlerts = (await tx.query(`SELECT severity,rule,message FROM owner_alerts WHERE resolved_at IS NULL
        ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, raised_at DESC LIMIT 5`)).rows;
      const pending = await one(`SELECT
          (SELECT COUNT(*) FROM department_proposals x WHERE NOT EXISTS (SELECT 1 FROM department_decisions d WHERE d.proposal_id=x.id))::int AS departments,
          (SELECT COUNT(*) FROM bot_birth_proposals x WHERE NOT EXISTS (SELECT 1 FROM bot_birth_decisions d WHERE d.proposal_id=x.id))::int AS births,
          (SELECT COUNT(*) FROM (SELECT DISTINCT ON (bot_id) id FROM bot_recommendations ORDER BY bot_id,sequence DESC) r
            WHERE NOT EXISTS (SELECT 1 FROM bot_recommendation_decisions d WHERE d.recommendation_id=r.id))::int AS recommendations,
          ((SELECT COUNT(*) FROM learning_workflow_links l WHERE l.step='source'
              AND NOT EXISTS (SELECT 1 FROM source_learning_reviews r WHERE r.request_id=l.reference_id))
           + (SELECT COUNT(*) FROM learning_workflow_links l WHERE l.step='transfer'
              AND NOT EXISTS (SELECT 1 FROM bot_knowledge_reviews r WHERE r.request_id=l.reference_id)))::int AS "learningReviews"`, []);
      const accuracy = (await tx.query(`SELECT s.bot_id,COUNT(*)::int AS scored,AVG(CASE WHEN o.correct THEN 1 ELSE 0 END)::float AS accuracy
        FROM trade_signal_outcomes o JOIN trade_signals s ON s.id=o.signal_id WHERE o.created_at >= now() - interval '90 days'
        GROUP BY s.bot_id HAVING COUNT(*) >= 5 ORDER BY accuracy DESC,s.bot_id`, [])).rows
        .map(r => ({ botId: r.bot_id, scored: r.scored, accuracy: Number(Number(r.accuracy).toFixed(3)) }));
      const tokens = [...(await usageByBot(tx, Math.max(1, Math.ceil(input.hours / 24)))).values()].reduce((s, u) => s + u.tokens, 0n);
      // the organisation around the trading: who is paused, which departments and contests are running
      const suspended = (await tx.query(`SELECT bot_id FROM (SELECT DISTINCT ON (bot_id) bot_id,suspended FROM bot_suspensions ORDER BY bot_id,sequence DESC) s
        WHERE suspended ORDER BY bot_id`, [])).rows.map(r => String(r.bot_id));
      const org = await one(`SELECT
          (SELECT COUNT(*) FROM departments WHERE status='active')::int AS "departmentsActive",
          (SELECT COUNT(*) FROM departments WHERE status='closed')::int AS "departmentsClosed",
          (SELECT COUNT(*) FROM hackathons WHERE status='open')::int AS "hackathonsOpen",
          (SELECT COUNT(*) FROM hackathons WHERE status='judging')::int AS "hackathonsJudging"`, []);
      const halted = (await one('SELECT halted FROM system_lock WHERE id=1', [])).halted as boolean;
      const needsOwner = [
        ...(halted ? ['New risk is HALTED.'] : []),
        ...topAlerts.filter(a => a.severity !== 'info').map(a => `${a.severity}: ${a.message}`),
        ...(pending.recommendations ? [`${pending.recommendations} management recommendation(s) await your decision (npm run agenda).`] : []),
        ...(pending.departments ? [`${pending.departments} department proposal(s) await your decision (npm run agenda).`] : []),
        ...(pending.births ? [`${pending.births} bot birth proposal(s) await your decision (npm run agenda).`] : []),
        ...(pending.learningReviews ? [`${pending.learningReviews} learning workflow stage(s) await an independent review (docs/learning-workflows.md).`] : []),
      ];
      return { windowHours: input.hours, generatedAt: new Date().toISOString(), mode: 'paper', halted,
        money: { realisedPaise: money.realised.toString(), unrealisedPaise: money.unrealised.toString(), totalPaise: (money.realised + money.unrealised).toString(),
          realisedInWindowPaise: trading.realised,
          stalePositions: perf.reduce((n, b) => n + b.openPositions.filter(p => p.stale).length, 0),
          byBot: perf.filter(b => b.totalPaise !== '0').map(b => ({ botId: b.botId, totalPaise: b.totalPaise, returnOnBudgetPct: b.returnOnBudgetPct })) },
        trading: { proposed: trading.proposed, accepted: trading.accepted, rejected: trading.rejected, executed: trading.executed,
          challenges: trading.challenges, scored: trading.scored, accuracy: trading.scored ? Number((trading.right / trading.scored).toFixed(3)) : null,
          lapsed: trading.lapsed, releasedPaise: trading.released, corporateActions: trading.corporate_actions },
        liveFitness: live,
        organisation: { suspendedBots: suspended, ...org },
        // BENCH-01: each bot against simply holding the basket over the same days
        benchmark: (await againstBasket(tx, null)).filter(b => b.verdict !== 'not-enough-days'),
        knowledge, alerts: Object.fromEntries(alerts.map(a => [a.severity, a.n])), needsOwner,
        bots: { best: accuracy.slice(0, 3), weakest: accuracy.slice(-3).reverse().filter(b => !accuracy.slice(0, 3).includes(b)) },
        compute: { tokens: tokens.toString() },
        note: 'Paper results. Read-only summary; decisions remain the owner\'s.' };
    }, false);
  }
}

type Request = { actor: Actor };
@Controller('v1')
export class OwnerDigestController {
  constructor(private readonly digest: OwnerDigest) {}
  @Post('owner/digest') @Allow('owner', 'evaluator') report(@Req() r: Request, @Body() b: unknown) { return this.digest.digest(r.actor, b); }
}
