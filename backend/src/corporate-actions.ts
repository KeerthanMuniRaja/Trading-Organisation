import { Body, Controller, Get, Headers, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { Actor, parse, permit, requireThat, symbol, uuid } from './core.js';
import { Database, Sql, audit } from './database.js';
import { Allow } from './security.js';
import { journal } from './treasury.js';

// Corporate actions (CORP-01): on a split or bonus issue every `sharesBefore` shares become `sharesAfter`, and the price
// falls in proportion. Without this, paper positions would show a fake loss of that size and calls reviewed before the
// ex-date would be scored against a price on the old basis. The owner records the action from verified evidence from an
// approved source; open positions are rescaled once (cost unchanged, so cost per share falls), and scoring rescales the
// reference price of any call reviewed before the ex-date. Fractional entitlements and open reservations are refused,
// to be settled by hand, rather than guessed.

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => !Number.isNaN(Date.parse(v + 'T00:00:00Z')), 'Invalid date');
const recordSchema = z.object({ symbol, kind: z.enum(['split', 'bonus']), sharesBefore: z.number().int().min(1).max(1000),
  sharesAfter: z.number().int().min(2).max(100000), exDate: day, evidenceId: z.uuid() }).strict()
  .refine(v => v.sharesAfter > v.sharesBefore, 'A split or bonus increases the number of shares');

const dividendSchema = z.object({ symbol, amountPerSharePaise: z.string().regex(/^[1-9][0-9]{0,9}$/), exDate: day, evidenceId: z.uuid() }).strict();

/** India trading day of a moment (NSE dates are IST). */
const indiaDay = (ms: number) => new Date(ms + 330 * 60_000).toISOString().slice(0, 10);

/** The reference price restated on the exit price's basis, for a call reviewed at `reviewedAt` and observed at
 *  `observedAt`: in ex-date order, a split or bonus divides it by its ratio and a dividend is subtracted (total return:
 *  the holder kept the cash). Only events with an ex-date after the review day and on or before the observation day. */
export async function restated(tx: Sql, ticker: string, refPaise: bigint, reviewedAt: number, observedAt: number) {
  const events = (await tx.query(`SELECT ex_date,shares_before,shares_after,NULL::bigint AS amount FROM corporate_actions
      WHERE symbol=$1 AND ex_date > $2::date AND ex_date <= $3::date
    UNION ALL SELECT ex_date,NULL,NULL,amount_per_share_paise FROM dividends WHERE symbol=$1 AND ex_date > $2::date AND ex_date <= $3::date
    ORDER BY 1,4 NULLS FIRST`, [ticker, indiaDay(reviewedAt), indiaDay(observedAt)])).rows;
  let ref = refPaise;
  for (const e of events) {
    if (e.amount === null) ref = (ref * BigInt(e.shares_before) * 2n + BigInt(e.shares_after)) / (BigInt(e.shares_after) * 2n);
    else ref = ref - BigInt(e.amount) > 0n ? ref - BigInt(e.amount) : 1n;
  }
  return { refPaise: ref, actions: events.length };
}

export class CorporateActions {
  constructor(private readonly db: Database) {}

  record(actor: Actor, key: string, raw: unknown) {
    permit(actor, 'owner');
    const input = parse(recordSchema, raw);
    requireThat(input.exDate <= indiaDay(Date.now()), 'Record an action on or after its ex-date, when the new basis applies', 400);
    return this.db.command(actor, 'corporate-action', key, input, async tx => {
      const e = (await tx.query('SELECT e.content,e.status,s.approved FROM evidence e JOIN sources s ON s.id=e.source_id WHERE e.id=$1', [input.evidenceId])).rows[0];
      requireThat(e && e.status === 'verified' && e.approved === true, 'Corporate action evidence must be verified and from an approved source');
      requireThat(String(e.content).includes(`NSE:${input.symbol} `), 'The evidence does not name this share as NSE:<share>');
      requireThat(!(await tx.query('SELECT 1 FROM corporate_actions WHERE symbol=$1 AND ex_date=$2', [input.symbol, input.exDate])).rows.length,
        'An action is already recorded for this share on this ex-date');
      requireThat(!(await tx.query("SELECT 1 FROM orders WHERE symbol=$1 AND status='reserved'", [input.symbol])).rows.length,
        'Cancel or lapse open reservations in this share first: their quantities are on the old basis');
      const positions = (await tx.query('SELECT bot_id,quantity::text AS q FROM positions WHERE symbol=$1 AND quantity>0 ORDER BY bot_id', [input.symbol])).rows;
      const fractional = positions.filter(p => BigInt(p.q) * BigInt(input.sharesAfter) % BigInt(input.sharesBefore) !== 0n).map(p => p.bot_id);
      requireThat(!fractional.length, `Fractional entitlement for ${fractional.join(', ')}: settle by hand (cash in lieu) before recording`);
      const actionId = uuid();
      await tx.query(`INSERT INTO corporate_actions(id,symbol,kind,shares_before,shares_after,ex_date,evidence_id,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [actionId, input.symbol, input.kind, input.sharesBefore, input.sharesAfter, input.exDate, input.evidenceId, actor.id]);
      const adjusted = [];
      for (const p of positions) {
        const after = BigInt(p.q) * BigInt(input.sharesAfter) / BigInt(input.sharesBefore);
        await tx.query('UPDATE positions SET quantity=$3 WHERE bot_id=$1 AND symbol=$2', [p.bot_id, input.symbol, after.toString()]);
        await tx.query('INSERT INTO corporate_action_adjustments(action_id,bot_id,quantity_before,quantity_after) VALUES($1,$2,$3,$4)', [actionId, p.bot_id, p.q, after.toString()]);
        adjusted.push({ botId: p.bot_id, quantityBefore: p.q, quantityAfter: after.toString() });
      }
      await audit(tx, actor, 'corporate.action.recorded', actionId, { ...input, adjusted });
      return { id: actionId, symbol: input.symbol, kind: input.kind, ratio: `${input.sharesBefore}->${input.sharesAfter}`, exDate: input.exDate, adjusted };
    });
  }

  /** CORP-02: pays a dividend to every bot holding the share at the ex-date. Entitled shares are today's holding without
   *  buys filled on or after the ex-date and with sales filled on or after it (those sellers held through the ex-date). */
  dividend(actor: Actor, key: string, raw: unknown) {
    permit(actor, 'owner');
    const input = parse(dividendSchema, raw);
    requireThat(input.exDate <= indiaDay(Date.now()), 'Record a dividend on or after its ex-date', 400);
    return this.db.command(actor, 'dividend', key, input, async tx => {
      const e = (await tx.query('SELECT e.content,e.status,s.approved FROM evidence e JOIN sources s ON s.id=e.source_id WHERE e.id=$1', [input.evidenceId])).rows[0];
      requireThat(e && e.status === 'verified' && e.approved === true, 'Dividend evidence must be verified and from an approved source');
      requireThat(String(e.content).includes(`NSE:${input.symbol} `), 'The evidence does not name this share as NSE:<share>');
      requireThat(!(await tx.query('SELECT 1 FROM dividends WHERE symbol=$1 AND ex_date=$2', [input.symbol, input.exDate])).rows.length,
        'A dividend is already recorded for this share on this ex-date');
      const holders = (await tx.query(`SELECT b.bot_id,(COALESCE(p.quantity,0)
          - COALESCE(SUM(f.quantity) FILTER (WHERE o.side='buy'),0) + COALESCE(SUM(f.quantity) FILTER (WHERE o.side='sell'),0))::text AS entitled
        FROM (SELECT bot_id FROM positions WHERE symbol=$1 UNION SELECT bot_id FROM orders WHERE symbol=$1) b
        LEFT JOIN positions p ON p.bot_id=b.bot_id AND p.symbol=$1
        LEFT JOIN orders o ON o.bot_id=b.bot_id AND o.symbol=$1 AND o.status='filled'
        LEFT JOIN fills f ON f.order_id=o.id AND ((f.created_at AT TIME ZONE 'UTC') + interval '330 minutes')::date >= $2::date
        GROUP BY b.bot_id,p.quantity ORDER BY b.bot_id`, [input.symbol, input.exDate])).rows;
      const dividendId = uuid(), paid = [];
      await tx.query('INSERT INTO dividends(id,symbol,amount_per_share_paise,ex_date,evidence_id,recorded_by) VALUES($1,$2,$3,$4,$5,$6)',
        [dividendId, input.symbol, input.amountPerSharePaise, input.exDate, input.evidenceId, actor.id]);
      for (const h of holders) {
        const shares = BigInt(h.entitled);
        if (shares <= 0n) continue;
        const amount = shares * BigInt(input.amountPerSharePaise);
        const journalId = await journal(tx, 'paper-dividend', `dividend:${dividendId}:${h.bot_id}`, { symbol: input.symbol, botId: h.bot_id },
          [['W1', amount], ['PNL', -amount]]);
        await tx.query('INSERT INTO dividend_payments(dividend_id,bot_id,quantity,amount_paise,journal_id) VALUES($1,$2,$3,$4,$5)',
          [dividendId, h.bot_id, shares.toString(), amount.toString(), journalId]);
        paid.push({ botId: h.bot_id, shares: shares.toString(), amountPaise: amount.toString() });
      }
      await audit(tx, actor, 'corporate.dividend.recorded', dividendId, { ...input, paid });
      return { id: dividendId, symbol: input.symbol, exDate: input.exDate, amountPerSharePaise: input.amountPerSharePaise, paid };
    });
  }

  list(actor: Actor) {
    permit(actor, 'owner', 'evaluator', 'researcher', 'trader');
    return this.db.transaction(async tx => ({ actions: (await tx.query(`SELECT a.*,to_char(a.ex_date,'YYYY-MM-DD') AS ex,
        (SELECT COALESCE(json_agg(json_build_object('botId',j.bot_id,'quantityBefore',j.quantity_before::text,'quantityAfter',j.quantity_after::text) ORDER BY j.bot_id),'[]')
          FROM corporate_action_adjustments j WHERE j.action_id=a.id) AS adjusted
      FROM corporate_actions a ORDER BY a.ex_date DESC,a.symbol`)).rows.map(r => ({ id: String(r.id), symbol: r.symbol, kind: r.kind,
        sharesBefore: r.shares_before, sharesAfter: r.shares_after, exDate: r.ex, evidenceId: String(r.evidence_id), adjusted: r.adjusted })),
      dividends: (await tx.query(`SELECT d.*,to_char(d.ex_date,'YYYY-MM-DD') AS ex,
          (SELECT COALESCE(json_agg(json_build_object('botId',p.bot_id,'shares',p.quantity::text,'amountPaise',p.amount_paise::text) ORDER BY p.bot_id),'[]')
            FROM dividend_payments p WHERE p.dividend_id=d.id) AS paid
        FROM dividends d ORDER BY d.ex_date DESC,d.symbol`)).rows.map(r => ({ id: String(r.id), symbol: r.symbol,
          amountPerSharePaise: String(r.amount_per_share_paise), exDate: r.ex, evidenceId: String(r.evidence_id), paid: r.paid })) }), false);
  }
}

type Request = { actor: Actor };
@Controller('v1')
export class CorporateActionsController {
  constructor(private readonly actions: CorporateActions) {}
  @Post('corporate-actions') @Allow('owner') record(@Req() r: Request, @Headers('idempotency-key') k: string, @Body() b: unknown) { return this.actions.record(r.actor, k ?? '', b); }
  @Post('corporate-actions/dividends') @Allow('owner') dividend(@Req() r: Request, @Headers('idempotency-key') k: string, @Body() b: unknown) { return this.actions.dividend(r.actor, k ?? '', b); }
  @Get('corporate-actions') @Allow('owner', 'evaluator', 'researcher', 'trader') list(@Req() r: Request) { return this.actions.list(r.actor); }
}
