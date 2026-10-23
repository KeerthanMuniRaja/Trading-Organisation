import { HttpException } from '@nestjs/common';
import { z } from 'zod';
import { Config } from './config.js';
import { Actor, bounded, ceilBps, id, parse, permit, positiveMoney, requireThat, symbol, timestamp, uuid } from './core.js';
import { Database, Sql, audit } from './database.js';
import { verifiedEvidence } from './organisation.js';
import { available, balance, journal, tradingLoss } from './treasury.js';
import { verifiedPrice } from './price-evidence.js';
import { liveReleases } from './bot-releases.js';
import { isSuspended } from './bot-control.js';
import { activePauses } from './protections.js';

const priceEvidence=z.object({evidenceId:z.uuid(),pricePaise:z.string().regex(/^[1-9][0-9]{0,13}$/),observedAt:timestamp}).strict();
/** Set only by TradeSignals.execute (never from a request body): the reviewed proposal this order carries out. */
export type SignalLink = { signalId: string };
type Refused = { botId?: string; symbol?: string; side?: 'buy' | 'sell'; quantity?: number; orderId?: string; signalId?: string | null };
const refusalQuery = z.object({ hours: z.number().int().min(1).max(24 * 31).default(24), botId: id.optional(),
  limit: z.number().int().min(1).max(200).default(50) }).strict();

export class PaperTrading {
  constructor(private readonly db:Database,private readonly config:Config) {}
  quote(actor:Actor,key:string,raw:unknown) {
    permit(actor,'market');const input=parse(z.object({symbol,bidPaise:positiveMoney,askPaise:positiveMoney,observedAt:timestamp,sourceId:id}).strict(),raw);
    requireThat(BigInt(input.askPaise)>=BigInt(input.bidPaise),'Ask must be at least bid',400);
    requireThat(Math.abs(Date.now()-Date.parse(input.observedAt))<=60000,'Quote is stale or future-dated',400);
    return this.db.command(actor,'quote',key,input,async tx=>{
      requireThat((await tx.query('SELECT id FROM sources WHERE id=$1 AND approved=true',[input.sourceId])).rows.length,'Approved market source required');
      const old=(await tx.query('SELECT observed_at FROM quotes WHERE symbol=$1',[input.symbol])).rows[0];
      requireThat(!old||new Date(old.observed_at).getTime()<Date.parse(input.observedAt),'Quote timestamp must advance');
      await tx.query('INSERT INTO quotes VALUES($1,$2,$3,$4,$5) ON CONFLICT(symbol) DO UPDATE SET bid=excluded.bid,ask=excluded.ask,observed_at=excluded.observed_at,source_id=excluded.source_id',[input.symbol,input.bidPaise,input.askPaise,input.observedAt,input.sourceId]);
      await audit(tx,actor,'paper.quote.recorded',input.symbol,input);return {symbol:input.symbol,mode:'paper'};
    });
  }
  private async tradingBot(tx:Sql,actor:Actor,botId:string) {
    permit(actor,'trader');requireThat(actor.botId===botId,'Credential is bound to another bot',403);
    const bot=(await tx.query("SELECT *,budget_paise::text AS budget FROM bots WHERE id=$1 AND state='paper' AND lifecycle_managed=false",[botId])).rows[0];requireThat(bot,'Bot is not qualified for paper trading',403);return bot;
  }
  // End-of-day execution: instead of a live quote, a fill may use a price stated in verified evidence from an approved
  // source (e.g. the next session's open, reported and independently verified), only for a reviewed proposal and only
  // when observed after that review (PAPER-04). The same slippage, fees and limits apply.
  private async evidencePrice(tx:Sql,ticker:string,e:{evidenceId:string;pricePaise:string;observedAt:string},signalId:string|null) {
    requireThat(signalId,'End-of-day prices are only for reviewed proposals (POST /v1/trading/signals/executions)');
    const {pricePaise,observedAt}=await verifiedPrice(tx,ticker,e);
    const review=(await tx.query('SELECT created_at FROM trade_signal_reviews WHERE signal_id=$1',[signalId])).rows[0];
    requireThat(review&&observedAt>new Date(review.created_at).getTime(),'An end-of-day price must be observed after the review that accepted the trade (no hindsight)');
    return pricePaise;
  }
  private async price(tx:Sql,ticker:string,side:'buy'|'sell',evidence?:{evidenceId:string;pricePaise:string;observedAt:string},signalId:string|null=null) {
    if(evidence){const base=await this.evidencePrice(tx,ticker,evidence,signalId);return side==='buy'?base+ceilBps(base,this.config.slippageBps):base*(10000n-BigInt(this.config.slippageBps))/10000n;}
    const quote=(await tx.query('SELECT q.*,q.ask::text AS a,q.bid::text AS b FROM quotes q JOIN sources s ON s.id=q.source_id WHERE q.symbol=$1 AND s.approved=true',[ticker])).rows[0];
    requireThat(quote&&Math.abs(Date.now()-new Date(quote.observed_at).getTime())<=60000,'Fresh approved quote required');
    return side==='buy'?BigInt(quote.a)+ceilBps(BigInt(quote.a),this.config.slippageBps):BigInt(quote.b)*(10000n-BigInt(this.config.slippageBps))/10000n;
  }
  private async permitNewRisk(tx:Sql,botId:string,symbol:string) {
    requireThat(!(await tx.query('SELECT halted FROM system_lock WHERE id=1')).rows[0]!.halted,'New risk is halted');
    requireThat(await tradingLoss(tx) < this.config.maxLoss,'Realised loss limit reached');
    const pauses=await activePauses(tx,botId,symbol);
    requireThat(!pauses.length,`New buys are paused by protection (${pauses.map(p=>p.code).join(', ')}); exits stay allowed and the pause lifts by itself`);
    const invalidLessons=await tx.query("SELECT c.lesson_id FROM bot_curriculum c JOIN lessons l ON l.id=c.lesson_id JOIN evidence e ON e.id=l.evidence_id JOIN sources s ON s.id=e.source_id WHERE c.bot_id=$1 AND (l.status<>'verified' OR e.status<>'verified' OR s.approved=false)",[botId]);
    const invalidEvaluation=await tx.query("SELECT x.id FROM experiments x JOIN datasets d ON d.id=x.dataset_id JOIN evidence e ON e.id=d.evidence_id JOIN sources s ON s.id=e.source_id WHERE x.bot_id=$1 AND x.state='passed' AND (e.status<>'verified' OR s.approved=false)",[botId]);
    requireThat(!invalidLessons.rows.length&&!invalidEvaluation.rows.length,'Qualification evidence has been revoked');
  }
  // TRUST-03: a business refusal (403, 404, 409) rolls its transaction back, so it is kept by a separate small write and
  // the same error is raised again; a malformed request (400) or a crash is not a refusal, and recording never changes
  // the answer
  private async refusing<T>(actor:Actor,stage:'reserve'|'fill',key:string,what:Refused,run:()=>Promise<T>):Promise<T> {
    try { return await run(); } catch(error) {
      const status=error instanceof HttpException?error.getStatus():0;
      if(status===403||status===404||status===409) {
        try {
          await this.db.transaction(tx=>tx.query(`INSERT INTO order_refusals(id,actor_id,stage,idempotency_key,bot_id,symbol,side,quantity,order_id,signal_id,status,message)
            SELECT $1,$2,$3,$4,COALESCE($5,o.bot_id),COALESCE($6,o.symbol),COALESCE($7,o.side),COALESCE($8::bigint,o.quantity),$9::uuid,COALESCE($10::uuid,o.signal_id),$11,$12
            FROM (SELECT 1) one LEFT JOIN orders o ON o.id=$9::uuid ON CONFLICT (actor_id,stage,idempotency_key) DO NOTHING`,
            [uuid(),actor.id,stage,key,what.botId??null,what.symbol??null,what.side??null,what.quantity??null,what.orderId??null,what.signalId??null,status,
              String((error as Error).message||'refused').slice(0,300)]),false);
        } catch { /* the refusal itself is the answer */ }
      }
      throw error;
    }
  }
  refusals(actor:Actor,raw:unknown) {
    permit(actor,'owner','evaluator');const input=parse(refusalQuery,raw);
    return this.db.transaction(async tx=>({refusals:(await tx.query(`SELECT id,actor_id,stage,bot_id,symbol,side,quantity::text AS quantity,order_id,signal_id,status,message,created_at
      FROM order_refusals WHERE created_at >= now() - ($1::int * interval '1 hour') AND ($2::text IS NULL OR bot_id=$2) ORDER BY created_at DESC,id LIMIT $3`,
      [input.hours,input.botId??null,input.limit])).rows.map(r=>({id:String(r.id),actorId:r.actor_id,stage:r.stage,botId:r.bot_id,symbol:r.symbol,side:r.side,
        quantity:r.quantity,orderId:r.order_id?String(r.order_id):null,signalId:r.signal_id?String(r.signal_id):null,status:r.status,message:r.message,
        at:new Date(r.created_at).toISOString()}))}),false);
  }
  reserve(actor:Actor,key:string,raw:unknown,link?:SignalLink) {
    permit(actor,'trader');const input=parse(z.object({botId:id,symbol,side:z.enum(['buy','sell']),quantity:z.number().int().min(1).max(1000000),evidenceId:z.uuid(),
      priceEvidence:priceEvidence.optional()}).strict(),raw);
    return this.refusing(actor,'reserve',key,{botId:input.botId,symbol:input.symbol,side:input.side,quantity:input.quantity,signalId:link?.signalId??null},
      ()=>this.db.command(actor,'reserve-order',key,{...input,...(link?{signalId:link.signalId}:{})},async tx=>{
      const bot=await this.tradingBot(tx,actor,input.botId);await verifiedEvidence(tx,input.evidenceId);
      // a bot under release control (RELEASE-01) trades only through reviewed proposals: no direct orders around review
      if(!link)requireThat(!(await liveReleases(tx,bot.id)).registered,'This bot trades only through reviewed proposals (POST /v1/trading/signals/executions)',403);
      else requireThat(!(await tx.query('SELECT 1 FROM orders WHERE signal_id=$1',[link.signalId])).rows.length,'This proposal already has an order');
      const price=await this.price(tx,input.symbol,input.side,input.priceEvidence,link?.signalId??null);
      let quantity=BigInt(input.quantity),reserved=0n;
      if(input.side==='buy') {
        await this.permitNewRisk(tx,bot.id,input.symbol);
        requireThat(!(await isSuspended(tx,bot.id)),'The bot is suspended: it may only reduce risk',403);
        const allReserved=BigInt((await tx.query("SELECT COALESCE(SUM(reserved_paise),0)::text AS value FROM orders WHERE status='reserved'")).rows[0]!.value);
        const ownCost=BigInt((await tx.query('SELECT COALESCE(SUM(cost_paise),0)::text AS value FROM positions WHERE bot_id=$1',[bot.id])).rows[0]!.value);
        const ownReserved=BigInt((await tx.query("SELECT COALESCE(SUM(reserved_paise),0)::text AS value FROM orders WHERE bot_id=$1 AND status='reserved'",[bot.id])).rows[0]!.value);
        const free=await available(tx),exposureRoom=this.config.maxExposure-await balance(tx,'POSITION')-allReserved,budgetRoom=BigInt(bot.budget)-ownCost-ownReserved;
        const cost=(q:bigint)=>{const g=bounded(price*q);return bounded(g+ceilBps(g,this.config.feeBps));};
        // A reviewed buy filled at a later price (e.g. the next open above the close it was sized at) buys as many of the
        // reviewed shares as still fit every limit, never more; a direct order keeps its exact quantity or is refused.
        if(link){const per=cost(1n),room=[this.config.maxOrder,free,exposureRoom,budgetRoom].reduce((a,b)=>b<a?b:a);
          if(per>0n&&room/per<quantity)quantity=room/per;while(quantity>0n&&cost(quantity)>room)quantity--;
          requireThat(quantity>0n,'Prices moved beyond the room left: not one share fits the limits');}
        reserved=cost(quantity);
        requireThat(reserved<=this.config.maxOrder,'Order exceeds configured limit');requireThat(free>=reserved,'Insufficient shared available capital');
        requireThat(reserved<=exposureRoom,'Organisation exposure limit exceeded');
        requireThat(reserved<=budgetRoom,'Bot budget exceeded');
      } else {
        const position=(await tx.query('SELECT quantity::text FROM positions WHERE bot_id=$1 AND symbol=$2',[bot.id,input.symbol])).rows[0];
        const pending=BigInt((await tx.query("SELECT COALESCE(SUM(quantity),0)::text AS value FROM orders WHERE bot_id=$1 AND symbol=$2 AND side='sell' AND status='reserved'",[bot.id,input.symbol])).rows[0]!.value);
        requireThat(position&&BigInt(position.quantity)-pending>=quantity,'Insufficient unreserved position');
      }
      const orderId=uuid();await tx.query("INSERT INTO orders(id,bot_id,symbol,side,quantity,reserved_paise,evidence_id,status,signal_id) VALUES($1,$2,$3,$4,$5,$6,$7,'reserved',$8)",[orderId,bot.id,input.symbol,input.side,quantity.toString(),reserved.toString(),input.evidenceId,link?.signalId??null]);
      await audit(tx,actor,'paper.order.reserved',orderId,{...input,quantity:Number(quantity),reservedPaise:reserved.toString()});return {id:orderId,state:'reserved',reservedPaise:reserved.toString(),quantity:quantity.toString()};
    }));
  }
  fill(actor:Actor,key:string,raw:unknown) {
    permit(actor,'trader');const input=parse(z.object({orderId:z.uuid(),priceEvidence:priceEvidence.optional()}).strict(),raw);
    return this.refusing(actor,'fill',key,{orderId:input.orderId},()=>this.db.command(actor,'fill-order',key,input,async tx=>{
      const order=(await tx.query('SELECT *,quantity::text AS qty,reserved_paise::text AS reserved FROM orders WHERE id=$1',[input.orderId])).rows[0];requireThat(order,'Order not found',404);
      const bot=await this.tradingBot(tx,actor,order.bot_id);requireThat(order.status==='reserved','Order is not reserved');await verifiedEvidence(tx,order.evidence_id);
      const price=await this.price(tx,order.symbol,order.side,input.priceEvidence,order.signal_id?String(order.signal_id):null),quantity=BigInt(order.qty),gross=bounded(price*quantity),fee=ceilBps(gross,this.config.feeBps);
      const position=(await tx.query('SELECT quantity::text,cost_paise::text FROM positions WHERE bot_id=$1 AND symbol=$2',[order.bot_id,order.symbol])).rows[0];
      let positionQty=BigInt(position?.quantity??0),positionCost=BigInt(position?.cost_paise??0),journalId:string;
      if(order.side==='buy') {
        await this.permitNewRisk(tx,bot.id,order.symbol);requireThat(!(await isSuspended(tx,bot.id)),'The bot is suspended: it may only reduce risk',403);
        requireThat(gross+fee<=BigInt(order.reserved),'Price moved beyond reservation; cancel and re-propose');
        requireThat(gross+fee<=this.config.maxOrder,'Order exceeds current configured limit');
        const allReserved=BigInt((await tx.query("SELECT COALESCE(SUM(reserved_paise),0)::text AS value FROM orders WHERE status='reserved'")).rows[0]!.value);
        requireThat(await balance(tx,'POSITION')+allReserved-BigInt(order.reserved)+gross+fee<=this.config.maxExposure,'Current organisation exposure limit exceeded');
        const ownCost=BigInt((await tx.query('SELECT COALESCE(SUM(cost_paise),0)::text AS value FROM positions WHERE bot_id=$1',[bot.id])).rows[0]!.value);
        const ownReserved=BigInt((await tx.query("SELECT COALESCE(SUM(reserved_paise),0)::text AS value FROM orders WHERE bot_id=$1 AND status='reserved'",[bot.id])).rows[0]!.value);
        requireThat(ownCost+ownReserved-BigInt(order.reserved)+gross+fee<=BigInt(bot.budget),'Current bot budget exceeded');
        journalId=await journal(tx,'paper-buy','order:'+order.id,{symbol:order.symbol,botId:order.bot_id},[['W1',-gross-fee],['POSITION',gross],['PNL',fee]]);
        positionQty+=quantity;positionCost+=gross;
      } else {
        requireThat(positionQty>=quantity,'Position changed');const cost=positionCost*quantity/positionQty;
        journalId=await journal(tx,'paper-sell','order:'+order.id,{symbol:order.symbol,botId:order.bot_id},[['W1',gross-fee],['POSITION',-cost],['PNL',cost-gross+fee]]);
        positionQty-=quantity;positionCost-=cost;
      }
      await tx.query('INSERT INTO positions VALUES($1,$2,$3,$4) ON CONFLICT(bot_id,symbol) DO UPDATE SET quantity=excluded.quantity,cost_paise=excluded.cost_paise',[order.bot_id,order.symbol,positionQty.toString(),positionCost.toString()]);
      const fillId=uuid();await tx.query('INSERT INTO fills(id,order_id,price_paise,quantity,fee_paise,journal_id) VALUES($1,$2,$3,$4,$5,$6)',[fillId,order.id,price.toString(),quantity.toString(),fee.toString(),journalId]);
      await tx.query("UPDATE orders SET status='filled' WHERE id=$1",[order.id]);await audit(tx,actor,'paper.order.filled',order.id,{fillId,journalId,pricePaise:price.toString(),feePaise:fee.toString()});
      return {id:order.id,state:'filled',fillId,pricePaise:price.toString(),feePaise:fee.toString(),mode:'paper'};
    }));
  }
  cancel(actor:Actor,key:string,raw:unknown) {
    permit(actor,'trader','owner');const input=parse(z.object({orderId:z.uuid()}).strict(),raw);
    return this.db.command(actor,'cancel-order',key,input,async tx=>{
      const order=(await tx.query('SELECT * FROM orders WHERE id=$1',[input.orderId])).rows[0];requireThat(order,'Order not found',404);
      if(actor.role==='trader')requireThat(actor.botId===order.bot_id,'Credential is bound to another bot',403);
      requireThat(order.status!=='filled','Filled order cannot be cancelled');await tx.query("UPDATE orders SET status='cancelled' WHERE id=$1",[order.id]);await audit(tx,actor,'paper.order.cancelled',order.id,{});return {id:order.id,state:'cancelled'};
    });
  }
  positions(actor:Actor) {
    permit(actor,'owner','trader');return this.db.transaction(async tx=>(await tx.query('SELECT bot_id,symbol,quantity::text,cost_paise::text FROM positions WHERE ($1::text IS NULL OR bot_id=$1) ORDER BY bot_id,symbol',[actor.role==='owner'?null:actor.botId])).rows);
  }
}
