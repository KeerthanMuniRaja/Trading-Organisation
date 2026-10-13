import { Body, Controller, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { Actor, id, parse, permit, requireThat } from './core.js';
import { Database } from './database.js';
import { usageByBot } from './compute-usage.js';
import { Allow } from './security.js';

// Bot scorecards (FITNESS-01): one view of each bot's net contribution, assembled from records the bot cannot write
// about itself: backend-computed fitness verdicts, scored proposal outcomes (accuracy and calibration), challenger
// accuracy, realised paper P&L from linked executions, and model compute. It also checks peer dependence: a bot whose
// proposals mostly mirror another bot's (same share, same action, within a day) adds little independent information.
// Scorecards recommend nothing automatically; promotion, retirement and budgets stay owner and lifecycle decisions.

const schema = z.object({ botId: id.optional(), days: z.number().int().min(1).max(365).default(90) }).strict();
const MIRROR_HOURS = 24, MIRROR_SHARE = 0.5, MIN_FOR_OVERLAP = 5;

export class BotScorecards {
  constructor(private readonly db: Database) {}

  cards(actor: Actor, raw: unknown) {
    permit(actor, 'owner', 'evaluator', 'trader');
    const input = parse(schema, raw);
    if (actor.role === 'trader') requireThat(!input.botId || input.botId === actor.botId, 'Traders see only their own scorecard', 403);
    const only = actor.role === 'trader' ? actor.botId! : input.botId ?? null;
    return this.db.transaction(async tx => {
      const bots = (await tx.query("SELECT id,department,state,budget_paise::text AS budget FROM bots WHERE ($1::text IS NULL OR id=$1) AND state<>'retired' ORDER BY id", [only])).rows;
      const since = `now() - ($1::int * interval '1 day')`;
      const fitness = (await tx.query(`SELECT DISTINCT ON (bot_id,role,baseline) bot_id,role,baseline,verdict FROM bot_fitness_reports
        ORDER BY bot_id,role,baseline,created_at DESC,id DESC`)).rows;
      const signals = (await tx.query(`SELECT s.id,s.bot_id,s.symbol,s.action,s.conviction,s.created_at,s.release_id,r.outcome AS review,o.correct,o.brier,
          x.realised_paise::text AS realised,x.fee_paise::text AS fee
        FROM trade_signals s LEFT JOIN trade_signal_reviews r ON r.signal_id=s.id LEFT JOIN trade_signal_outcomes o ON o.signal_id=s.id
        LEFT JOIN trade_signal_executions x ON x.signal_id=s.id WHERE s.created_at >= ${since}`, [input.days])).rows;
      const challenges = (await tx.query(`SELECT c.challenger_bot_id,c.stance,o.correct FROM trade_signal_challenges c
        JOIN trade_signal_outcomes o ON o.signal_id=c.signal_id WHERE c.created_at >= ${since}`, [input.days])).rows;
      const compute = await usageByBot(tx, input.days);

      const cards = bots.map(b => {
        const mine = signals.filter(s => s.bot_id === b.id);
        const scored = mine.filter(s => s.correct !== null);
        const briers = scored.map(s => s.brier).filter(v => v !== null).map(Number);
        const myChallenges = challenges.filter(c => c.challenger_bot_id === b.id);
        const challengeRight = myChallenges.filter(c => (c.stance === 'oppose' ? !c.correct : c.correct)).length;
        const realised = mine.reduce((sum, s) => sum + BigInt(s.realised ?? 0), 0n) - mine.reduce((sum, s) => sum + (s.realised === null ? BigInt(s.fee ?? 0) : 0n), 0n);
        const tokens = compute.get(b.id)?.tokens ?? 0n;
        // peer dependence: share of this bot's actionable proposals mirrored by another bot within a day
        const actionable = mine.filter(s => s.action !== 'no-action');
        const mirrors = new Map<string, number>();
        for (const s of actionable) {
          const t = new Date(s.created_at).getTime();
          for (const other of new Set(signals.filter(o => o.bot_id !== b.id && o.symbol === s.symbol && o.action === s.action
            && Math.abs(new Date(o.created_at).getTime() - t) <= MIRROR_HOURS * 3_600_000).map(o => o.bot_id as string)))
            mirrors.set(other, (mirrors.get(other) ?? 0) + 1);
        }
        const overlaps = actionable.length >= MIN_FOR_OVERLAP
          ? [...mirrors.entries()].filter(([, n]) => n / actionable.length >= MIRROR_SHARE).map(([bot, n]) => ({ botId: bot, mirroredShare: Number((n / actionable.length).toFixed(2)) }))
          : [];
        const verdicts = fitness.filter(f => f.bot_id === b.id).map(f => ({ role: f.role, baseline: f.baseline, verdict: f.verdict }));
        const flags: string[] = [];
        if (!scored.length && !myChallenges.length && !verdicts.length) flags.push('no evidence of contribution yet');
        if (verdicts.some(v => v.verdict === 'worse-than-baseline')) flags.push('worse than its baseline in a fitness report');
        if (scored.length >= 10 && scored.filter(s => s.correct).length / scored.length < 0.4) flags.push('fewer than 40% of scored calls right');
        if (briers.length >= 10 && briers.reduce((a, v) => a + v, 0) / briers.length > 0.25) flags.push('stated probabilities worse than always saying 50%');
        if (overlaps.length) flags.push('mostly mirrors ' + overlaps.map(o => o.botId).join(', ') + ': little independent information');
        if (tokens > 0n && realised < 0n) flags.push('spends compute and loses money');
        return { botId: b.id, department: b.department, state: b.state, budgetPaise: b.budget, fitness: verdicts,
          proposals: { made: mine.length, accepted: mine.filter(s => s.review === 'accepted').length, executed: mine.filter(s => s.realised !== null || s.fee !== null).length,
            scored: scored.length, accuracy: scored.length ? Number((scored.filter(s => s.correct).length / scored.length).toFixed(3)) : null,
            meanBrier: briers.length ? Number((briers.reduce((a, v) => a + v, 0) / briers.length).toFixed(4)) : null },
          // live evidence for release decisions: the same bot's scored calls, split by the release that made them
          byRelease: [...new Set(scored.map(s => s.release_id ? String(s.release_id) : 'unreleased'))].sort().map(release => {
            const calls = scored.filter(s => (s.release_id ? String(s.release_id) : 'unreleased') === release);
            return { releaseId: release, scored: calls.length, accuracy: Number((calls.filter(s => s.correct).length / calls.length).toFixed(3)) };
          }),
          challenges: { scored: myChallenges.length, accuracy: myChallenges.length ? Number((challengeRight / myChallenges.length).toFixed(3)) : null },
          money: { realisedNetPaise: realised.toString() },
          compute: { tokens: tokens.toString(), realisedPaisePerMillionTokens: tokens > 0n ? Number(realised * 1_000_000n / tokens) : null },
          overlaps, flags };
      });
      return { days: input.days, cards,
        note: 'Assembled from records a bot cannot write about itself. Recommendations stay with the owner and lifecycle.' };
    }, false);
  }
}

type Request = { actor: Actor };
@Controller('v1')
export class BotScorecardsController {
  constructor(private readonly scorecards: BotScorecards) {}
  @Post('bots/scorecards') @Allow('owner', 'evaluator', 'trader') cards(@Req() r: Request, @Body() b: unknown) { return this.scorecards.cards(r.actor, b); }
}
