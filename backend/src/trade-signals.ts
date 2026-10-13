import { Body, Controller, Headers, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { Config } from './config.js';
import { Actor, ceilBps, digest, id, parse, permit, requireThat, symbol, timestamp, uuid } from './core.js';
import { Database, Sql, audit } from './database.js';
import { Allow } from './security.js';
import { available, balance } from './treasury.js';

// Structured trade proposals (DECISION-01). A bot states what it would do, why, how sure it is, when the idea expires and
// what would prove it wrong, citing verified evidence. A deterministic risk review then accepts (with a size computed from
// the configured limits), rejects with recorded reasons, marks it expired, or acknowledges an explicit no-action call.
// The reviewer triggers the review but cannot choose its outcome, and a model cannot change any limit. An accepted
// review is an order intent: the bot still reserves the order through paper trading, which re-checks every limit.
// After the horizon an independent evaluator records the realised price, and the backend scores the call, so every bot
// builds a calibrated track record (accuracy by conviction, Brier score of its stated probabilities).

// v2 (SPECIALIST-01): an opposing challenge citing verified evidence sizes a high-conviction long as medium.
export const RULES_VERSION = 'signal-risk-v2';
export const COST_BPS = 30; // round-trip trading cost: a long call must beat it to count as right
const QUOTE_FRESH_MS = 60_000;
const SIZE = { high: 1, medium: 0.5, low: 0.25 } as const;
const text = (max: number) => z.string().trim().min(1).max(max);

const proposalSchema = z.object({
  botId: id, symbol, action: z.enum(['enter-long', 'exit', 'no-action']), horizonDays: z.number().int().min(1).max(365),
  conviction: z.enum(['low', 'medium', 'high']), probabilityPct: z.number().int().min(1).max(99).optional(),
  targetWeightPct: z.number().int().min(1).max(100).optional(),
  thesis: text(600), invalidation: text(300).optional(), expiresAt: timestamp,
  evidenceIds: z.array(z.uuid()).max(10).default([]),
  model: text(120).optional(), promptVersion: text(64).optional(),
}).strict()
  .refine(v => v.action === 'no-action' || v.invalidation, 'A trade proposal must say what would prove it wrong')
  .refine(v => v.action === 'no-action' || v.evidenceIds.length > 0, 'A trade proposal must cite verified evidence')
  .refine(v => new Set(v.evidenceIds).size === v.evidenceIds.length, 'Evidence listed twice');
const reviewSchema = z.object({ signalId: z.uuid() }).strict();
const challengeSchema = z.object({ signalId: z.uuid(), stance: z.enum(['oppose', 'support-with-caveat']), argument: text(600), evidenceId: z.uuid().optional() }).strict();
const outcomeSchema = z.object({ signalId: z.uuid(), exitPricePaise: z.string().regex(/^[1-9]\d{0,15}$/), observedAt: timestamp, evidenceId: z.uuid() }).strict();
const querySchema = z.object({ botId: id.optional(), limit: z.number().int().min(1).max(200).default(50) }).strict();

/** Was the call right? A long must beat round-trip costs; an exit is right if the price then fell; no-action is right
 *  if no profitable long was missed. Pure, so the rule is testable and identical for every bot. */
export function scoreCall(action: string, moveBps: number) {
  if (action === 'enter-long') return moveBps > COST_BPS;
  if (action === 'exit') return moveBps < 0;
  return moveBps <= COST_BPS;
}

async function verifiedEvidenceIds(tx: Sql, ids: string[]) {
  if (!ids.length) return [];
  return (await tx.query(`SELECT e.id FROM evidence e JOIN sources s ON s.id=e.source_id WHERE e.id=ANY($1::uuid[])
    AND e.status='verified' AND s.approved=true`, [ids])).rows.map(r => String(r.id));
}

export class TradeSignals {
  constructor(private readonly db: Database, private readonly config: Config) {}

  propose(actor: Actor, key: string, raw: unknown) {
    permit(actor, 'trader', 'researcher');
    const input = parse(proposalSchema, raw);
    requireThat(actor.botId === input.botId, 'A bot can only propose under its own identity', 403);
    const expires = Date.parse(input.expiresAt), now = Date.now();
    requireThat(expires > now, 'A proposal must expire in the future', 400);
    requireThat(expires <= now + input.horizonDays * 86_400_000, 'A proposal cannot outlive its horizon', 400);
    return this.db.command(actor, 'trade-signal', key, input, async tx => {
      const bot = (await tx.query('SELECT state FROM bots WHERE id=$1', [input.botId])).rows[0];
      requireThat(bot, 'Bot not found', 404);
      requireThat(bot.state !== 'retired', 'Retired bots cannot propose trades', 403);
      const verified = await verifiedEvidenceIds(tx, input.evidenceIds);
      requireThat(verified.length === input.evidenceIds.length, 'Every cited evidence must be verified and from an approved source');
      const hash = digest(input);
      const old = (await tx.query('SELECT id FROM trade_signals WHERE content_hash=$1', [hash])).rows[0];
      if (old) return { id: String(old.id), duplicate: true };
      const signalId = uuid();
      await tx.query(`INSERT INTO trade_signals(id,bot_id,symbol,action,horizon_days,conviction,probability_pct,thesis,invalidation,expires_at,
        model,prompt_version,author,content_hash,target_weight_pct) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [signalId, input.botId, input.symbol, input.action, input.horizonDays, input.conviction, input.probabilityPct ?? null, input.thesis,
          input.invalidation ?? null, input.expiresAt, input.model ?? null, input.promptVersion ?? null, actor.id, hash, input.targetWeightPct ?? null]);
      for (const evidenceId of input.evidenceIds) await tx.query('INSERT INTO trade_signal_evidence VALUES($1,$2)', [signalId, evidenceId]);
      await audit(tx, actor, 'trade.signal.proposed', signalId, { botId: input.botId, symbol: input.symbol, action: input.action, conviction: input.conviction });
      return { id: signalId, duplicate: false };
    });
  }

  /** Deterministic risk review: every rule is code; the outcome and size cannot be chosen by the caller. */
  review(actor: Actor, key: string, raw: unknown) {
    permit(actor, 'owner', 'evaluator');
    const input = parse(reviewSchema, raw);
    return this.db.command(actor, 'trade-signal-review', key, input, async tx => {
      const signal = (await tx.query('SELECT * FROM trade_signals WHERE id=$1', [input.signalId])).rows[0];
      requireThat(signal, 'Signal not found', 404);
      requireThat(signal.author !== actor.id, 'The proposer cannot review its own signal', 403);
      const existing = (await tx.query('SELECT * FROM trade_signal_reviews WHERE signal_id=$1', [input.signalId])).rows[0];
      if (existing) return { ...reviewView(existing), duplicate: true };
      const reasons: string[] = [];
      let outcome: 'accepted' | 'rejected' | 'expired' | 'acknowledged' = 'rejected', side: string | null = null, quantity: bigint | null = null;
      const quote = (await tx.query(`SELECT q.bid::text AS bid,q.ask::text AS ask,q.observed_at FROM quotes q JOIN sources s ON s.id=q.source_id
        WHERE q.symbol=$1 AND s.approved=true`, [signal.symbol])).rows[0];
      const fresh = quote && Math.abs(Date.now() - new Date(quote.observed_at).getTime()) <= QUOTE_FRESH_MS;
      const reference = fresh ? (BigInt(quote.bid) + BigInt(quote.ask)) / 2n : null;
      if (new Date(signal.expires_at).getTime() <= Date.now()) { outcome = 'expired'; reasons.push('expired-before-review'); }
      else if (signal.action === 'no-action') { outcome = 'acknowledged'; reasons.push('no-action-recorded'); }
      else {
        if ((await tx.query('SELECT halted FROM system_lock WHERE id=1')).rows[0]!.halted) reasons.push('system-halted');
        const bot = (await tx.query('SELECT state,lifecycle_managed,budget_paise::text AS budget FROM bots WHERE id=$1', [signal.bot_id])).rows[0]!;
        if (bot.state !== 'paper' || bot.lifecycle_managed) reasons.push('bot-not-qualified-for-paper-trading');
        const cited = (await tx.query('SELECT evidence_id FROM trade_signal_evidence WHERE signal_id=$1', [signal.id])).rows.map(r => String(r.evidence_id));
        if ((await verifiedEvidenceIds(tx, cited)).length !== cited.length) reasons.push('evidence-no-longer-verified');
        if (!fresh) reasons.push('no-fresh-approved-quote');
        if (signal.action === 'enter-long') {
          if (signal.probability_pct !== null && signal.probability_pct < 50) reasons.push('stated-probability-below-even');
          if (-(await balance(tx, 'PNL')) <= -this.config.maxLoss) reasons.push('realised-loss-limit-reached');
          if (fresh && !reasons.length) {
            const price = BigInt(quote.ask) + ceilBps(BigInt(quote.ask), this.config.slippageBps);
            const perShare = price + ceilBps(price, this.config.feeBps);
            const sum = async (sql: string, params: unknown[]) => BigInt((await tx.query(sql, params)).rows[0]!.value);
            const allReserved = await sum("SELECT COALESCE(SUM(reserved_paise),0)::text AS value FROM orders WHERE status='reserved'", []);
            const own = await sum('SELECT COALESCE(SUM(cost_paise),0)::text AS value FROM positions WHERE bot_id=$1', [signal.bot_id])
              + await sum("SELECT COALESCE(SUM(reserved_paise),0)::text AS value FROM orders WHERE bot_id=$1 AND status='reserved'", [signal.bot_id]);
            const limits: [string, bigint][] = [['order-limit', this.config.maxOrder], ['bot-budget', BigInt(bot.budget) - own],
              ['available-capital', await available(tx)], ['exposure-limit', this.config.maxExposure - await balance(tx, 'POSITION') - allReserved]];
            let [binding, room] = limits.reduce((a, b) => (b[1] < a[1] ? b : a));
            // an independent challenger's evidenced objection halves a high-conviction long (deterministic, recorded)
            let conviction = signal.conviction as keyof typeof SIZE;
            const objection = (await tx.query(`SELECT 1 FROM trade_signal_challenges c JOIN evidence e ON e.id=c.evidence_id JOIN sources s ON s.id=e.source_id
              WHERE c.signal_id=$1 AND c.stance='oppose' AND e.status='verified' AND s.approved=true LIMIT 1`, [signal.id])).rows.length;
            if (objection && conviction === 'high') { conviction = 'medium'; reasons.push('evidenced-objection-sized-as-medium'); }
            let allowance = room * BigInt(Math.round(SIZE[conviction] * 100)) / 100n;
            if (signal.target_weight_pct !== null) {
              // never more than the stated share of the bot's budget in this instrument, counting what it already holds or reserved
              const inSymbol = await sum('SELECT COALESCE(SUM(cost_paise),0)::text AS value FROM positions WHERE bot_id=$1 AND symbol=$2', [signal.bot_id, signal.symbol])
                + await sum("SELECT COALESCE(SUM(reserved_paise),0)::text AS value FROM orders WHERE bot_id=$1 AND symbol=$2 AND status='reserved'", [signal.bot_id, signal.symbol]);
              const toTarget = BigInt(bot.budget) * BigInt(signal.target_weight_pct) / 100n - inSymbol;
              if (toTarget < allowance) [binding, allowance] = ['target-weight', toTarget];
            }
            quantity = allowance > 0n ? allowance / perShare : 0n;
            if (quantity < 1n) { quantity = null; reasons.push('size-below-one-share', binding); }
            else { outcome = 'accepted'; side = 'buy'; reasons.push(`sized-by-${binding}`, `conviction-${conviction}`); }
          }
        } else if (fresh && !reasons.length) {
          const held = (await tx.query('SELECT quantity::text AS q FROM positions WHERE bot_id=$1 AND symbol=$2', [signal.bot_id, signal.symbol])).rows[0];
          const pending = BigInt((await tx.query("SELECT COALESCE(SUM(quantity),0)::text AS value FROM orders WHERE bot_id=$1 AND symbol=$2 AND side='sell' AND status='reserved'",
            [signal.bot_id, signal.symbol])).rows[0]!.value);
          const free = BigInt(held?.q ?? 0) - pending;
          if (free < 1n) reasons.push('no-unreserved-position');
          else { outcome = 'accepted'; side = 'sell'; quantity = free; reasons.push('exit-whole-unreserved-position'); }
        }
      }
      const reviewId = uuid();
      const row = (await tx.query(`INSERT INTO trade_signal_reviews(id,signal_id,outcome,reasons,side,quantity,reference_price_paise,quote_observed_at,
        rules_version,reviewer) VALUES($1,$2,$3,$4::text[],$5,$6,$7,$8,$9,$10) RETURNING *`,
        [reviewId, signal.id, outcome, reasons, side, quantity?.toString() ?? null, reference?.toString() ?? null,
          fresh ? quote.observed_at : null, RULES_VERSION, actor.id])).rows[0]!;
      await audit(tx, actor, 'trade.signal.reviewed', signal.id, { outcome, reasons, side, quantity: quantity?.toString() ?? null });
      return { ...reviewView(row), duplicate: false };
    });
  }

  /** An independent challenger (a different bot) argues against, or qualifies, a proposal before it is reviewed. */
  challenge(actor: Actor, key: string, raw: unknown) {
    permit(actor, 'trader', 'researcher');
    const input = parse(challengeSchema, raw);
    requireThat(!!actor.botId, 'Challenges are made under a bot identity', 403);
    return this.db.command(actor, 'trade-signal-challenge', key, input, async tx => {
      const signal = (await tx.query('SELECT bot_id,author,expires_at FROM trade_signals WHERE id=$1', [input.signalId])).rows[0];
      requireThat(signal, 'Signal not found', 404);
      requireThat(signal.bot_id !== actor.botId && signal.author !== actor.id, 'A bot cannot challenge its own proposal', 403);
      requireThat(!(await tx.query('SELECT 1 FROM trade_signal_reviews WHERE signal_id=$1', [input.signalId])).rows.length, 'Challenges must come before the review');
      requireThat(new Date(signal.expires_at).getTime() > Date.now(), 'The proposal has expired');
      if (input.evidenceId) requireThat((await verifiedEvidenceIds(tx, [input.evidenceId])).length === 1, 'Cited evidence must be verified and from an approved source');
      const old = (await tx.query('SELECT id FROM trade_signal_challenges WHERE signal_id=$1 AND challenger_bot_id=$2', [input.signalId, actor.botId])).rows[0];
      requireThat(!old, 'This bot has already challenged the proposal');
      const challengeId = uuid();
      await tx.query(`INSERT INTO trade_signal_challenges(id,signal_id,challenger_bot_id,stance,argument,evidence_id,author) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [challengeId, input.signalId, actor.botId, input.stance, input.argument, input.evidenceId ?? null, actor.id]);
      await audit(tx, actor, 'trade.signal.challenged', input.signalId, { challengerBotId: actor.botId, stance: input.stance, evidenced: !!input.evidenceId });
      return { id: challengeId };
    });
  }

  /** After the horizon, an evaluator independent of the proposer records the realised price from verified evidence. */
  outcome(actor: Actor, key: string, raw: unknown) {
    permit(actor, 'owner', 'evaluator');
    const input = parse(outcomeSchema, raw);
    return this.db.command(actor, 'trade-signal-outcome', key, input, async tx => {
      const signal = (await tx.query('SELECT * FROM trade_signals WHERE id=$1', [input.signalId])).rows[0];
      requireThat(signal, 'Signal not found', 404);
      requireThat(signal.author !== actor.id, 'The proposer cannot score its own signal', 403);
      const review = (await tx.query('SELECT reference_price_paise::text AS ref FROM trade_signal_reviews WHERE signal_id=$1', [signal.id])).rows[0];
      requireThat(review?.ref, 'Only reviewed signals with a reference price can be scored');
      const due = new Date(signal.created_at).getTime() + signal.horizon_days * 86_400_000;
      requireThat(Date.parse(input.observedAt) >= due, 'The horizon has not passed at that observation');
      requireThat(Date.parse(input.observedAt) <= Date.now() + 60_000, 'Observation cannot be in the future', 400);
      requireThat((await verifiedEvidenceIds(tx, [input.evidenceId])).length === 1, 'Price evidence must be verified and from an approved source');
      const old = (await tx.query('SELECT * FROM trade_signal_outcomes WHERE signal_id=$1', [signal.id])).rows[0];
      if (old) return { ...outcomeView(old), duplicate: true };
      const ref = BigInt(review.ref), exit = BigInt(input.exitPricePaise);
      const moveBps = Number((exit - ref) * 10000n / ref);
      const correct = scoreCall(signal.action, moveBps);
      const brier = signal.probability_pct === null ? null : (signal.probability_pct / 100 - (correct ? 1 : 0)) ** 2;
      const row = (await tx.query(`INSERT INTO trade_signal_outcomes(id,signal_id,exit_price_paise,observed_at,move_bps,correct,brier,evidence_id,evaluator)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [uuid(), signal.id, input.exitPricePaise, input.observedAt, moveBps, correct, brier,
        input.evidenceId, actor.id])).rows[0]!;
      await audit(tx, actor, 'trade.signal.scored', signal.id, { moveBps, correct });
      return { ...outcomeView(row), duplicate: false };
    });
  }

  /** Signals with their reviews and outcomes, plus each bot's track record: accuracy by conviction and calibration. */
  query(actor: Actor, raw: unknown) {
    permit(actor, 'owner', 'researcher', 'evaluator', 'trader');
    const input = parse(querySchema, raw);
    const botId = actor.role === 'trader' ? actor.botId : input.botId;
    if (actor.role === 'trader') requireThat(!input.botId || input.botId === actor.botId, 'Traders see only their own signals', 403);
    return this.db.transaction(async tx => {
      const rows = (await tx.query(`SELECT s.*,r.outcome AS review_outcome,r.reasons,r.side,r.quantity::text AS quantity,
          r.reference_price_paise::text AS reference,o.move_bps,o.correct,o.brier,
          ARRAY(SELECT evidence_id::text FROM trade_signal_evidence x WHERE x.signal_id=s.id ORDER BY evidence_id) AS evidence_ids
        FROM trade_signals s LEFT JOIN trade_signal_reviews r ON r.signal_id=s.id LEFT JOIN trade_signal_outcomes o ON o.signal_id=s.id
        WHERE ($1::text IS NULL OR s.bot_id=$1) ORDER BY s.created_at DESC,s.id DESC LIMIT $2`, [botId ?? null, input.limit])).rows;
      const signals = rows.map(r => ({ id: String(r.id), botId: r.bot_id, symbol: r.symbol, action: r.action, horizonDays: r.horizon_days,
        conviction: r.conviction, probabilityPct: r.probability_pct, targetWeightPct: r.target_weight_pct, thesis: r.thesis, invalidation: r.invalidation,
        createdAt: new Date(r.created_at).toISOString(), expiresAt: new Date(r.expires_at).toISOString(), evidenceIds: r.evidence_ids,
        model: r.model, promptVersion: r.prompt_version,
        review: r.review_outcome ? { outcome: r.review_outcome, reasons: r.reasons, side: r.side, quantity: r.quantity, referencePricePaise: r.reference } : null,
        outcome: r.correct === null || r.correct === undefined ? null : { moveBps: r.move_bps, correct: r.correct, brier: r.brier === null ? null : Number(r.brier) } }));
      const ids = signals.map(s => s.id);
      const challenges = ids.length ? (await tx.query(`SELECT signal_id,challenger_bot_id,stance,argument,evidence_id FROM trade_signal_challenges
        WHERE signal_id=ANY($1::uuid[]) ORDER BY created_at`, [ids])).rows : [];
      const withChallenges = signals.map(s => ({ ...s, challenges: challenges.filter(c => String(c.signal_id) === s.id).map(c => ({ challengerBotId: c.challenger_bot_id,
        stance: c.stance, argument: c.argument, evidenceId: c.evidence_id ? String(c.evidence_id) : null })) }));
      return { signals: withChallenges, trackRecord: trackRecord(signals), challengerRecord: challengerRecord(withChallenges),
        note: 'A track record is descriptive; promotion, retirement and budgets stay owner and lifecycle decisions.' };
    }, false);
  }
}

type Scored = { botId: string; conviction: string; outcome: { correct: boolean; brier: number | null } | null };
/** Per bot: scored calls, accuracy overall and by conviction, and mean Brier score where probabilities were stated
 *  (0 is perfect, 0.25 is what always saying 50% earns). */
export function trackRecord(signals: Scored[]) {
  const bots = new Map<string, Scored[]>();
  for (const s of signals) if (s.outcome) bots.set(s.botId, [...(bots.get(s.botId) ?? []), s]);
  return [...bots.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([botId, list]) => {
    const rate = (xs: Scored[]) => xs.length ? Number((xs.filter(x => x.outcome!.correct).length / xs.length).toFixed(3)) : null;
    const briers = list.map(s => s.outcome!.brier).filter((b): b is number => b !== null);
    return { botId, scored: list.length, accuracy: rate(list),
      byConviction: Object.fromEntries(['low', 'medium', 'high'].map(c => [c, { scored: list.filter(s => s.conviction === c).length,
        accuracy: rate(list.filter(s => s.conviction === c)) }])),
      meanBrier: briers.length ? Number((briers.reduce((a, b) => a + b, 0) / briers.length).toFixed(4)) : null };
  });
}

type Challenged = { outcome: { correct: boolean } | null; challenges: { challengerBotId: string; stance: string }[] };
/** Challengers are scored like proposers: an opposition is right when the call was wrong; a supported-with-caveat
 *  challenge is right when the call was right. A challenger that is never right adds noise, not value. */
export function challengerRecord(signals: Challenged[]) {
  const bots = new Map<string, { scored: number; right: number; opposed: number }>();
  for (const s of signals) {
    if (!s.outcome) continue;
    for (const c of s.challenges) {
      const cur = bots.get(c.challengerBotId) ?? { scored: 0, right: 0, opposed: 0 };
      const right = c.stance === 'oppose' ? !s.outcome.correct : s.outcome.correct;
      bots.set(c.challengerBotId, { scored: cur.scored + 1, right: cur.right + (right ? 1 : 0), opposed: cur.opposed + (c.stance === 'oppose' ? 1 : 0) });
    }
  }
  return [...bots.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([botId, r]) => ({ botId, ...r, accuracy: Number((r.right / r.scored).toFixed(3)) }));
}

function reviewView(r: Record<string, any>) {
  return { signalId: String(r.signal_id), outcome: r.outcome, reasons: r.reasons, side: r.side ?? null,
    quantity: r.quantity === null ? null : String(r.quantity), referencePricePaise: r.reference_price_paise === null ? null : String(r.reference_price_paise),
    rulesVersion: r.rules_version };
}
function outcomeView(r: Record<string, any>) {
  return { signalId: String(r.signal_id), moveBps: r.move_bps, correct: r.correct, brier: r.brier === null ? null : Number(r.brier) };
}

type Request = { actor: Actor };
@Controller('v1')
export class TradeSignalsController {
  constructor(private readonly signals: TradeSignals) {}
  @Post('trading/signals') @Allow('trader', 'researcher') propose(@Req() r: Request, @Headers('idempotency-key') k: string, @Body() b: unknown) { return this.signals.propose(r.actor, k ?? '', b); }
  @Post('trading/signals/challenges') @Allow('trader', 'researcher') challenge(@Req() r: Request, @Headers('idempotency-key') k: string, @Body() b: unknown) { return this.signals.challenge(r.actor, k ?? '', b); }
  @Post('trading/signals/reviews') @Allow('owner', 'evaluator') review(@Req() r: Request, @Headers('idempotency-key') k: string, @Body() b: unknown) { return this.signals.review(r.actor, k ?? '', b); }
  @Post('trading/signals/outcomes') @Allow('owner', 'evaluator') outcome(@Req() r: Request, @Headers('idempotency-key') k: string, @Body() b: unknown) { return this.signals.outcome(r.actor, k ?? '', b); }
  @Post('trading/signals/query') @Allow('owner', 'researcher', 'evaluator', 'trader') query(@Req() r: Request, @Body() b: unknown) { return this.signals.query(r.actor, b); }
}
