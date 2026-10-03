import { z } from 'zod';
import { Config } from './config.js';
import { Actor, bounded, ceilBps, id, parse, permit, positiveMoney, requireThat, symbol, timestamp, uuid } from './core.js';
import { Database, Sql, audit } from './database.js';
import { verifiedEvidence } from './organisation.js';
import { available, balance, journal } from './treasury.js';

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
  private async price(tx:Sql,ticker:string,side:'buy'|'sell') {
    const quote=(await tx.query('SELECT q.*,q.ask::text AS a,q.bid::text AS b FROM quotes q JOIN sources s ON s.id=q.source_id WHERE q.symbol=$1 AND s.approved=true',[ticker])).rows[0];
    requireThat(quote&&Math.abs(Date.now()-new Date(quote.observed_at).getTime())<=60000,'Fresh approved quote required');
    return side==='buy'?BigInt(quote.a)+ceilBps(BigInt(quote.a),this.config.slippageBps):BigInt(quote.b)*(10000n-BigInt(this.config.slippageBps))/10000n;
  }
  private async permitNewRisk(tx:Sql,botId:string) {
    requireThat(!(await tx.query('SELECT halted FROM system_lock WHERE id=1')).rows[0]!.halted,'New risk is halted');
    requireThat(-(await balance(tx,'PNL')) > -this.config.maxLoss,'Realised loss limit reached');
    const invalidLessons=await tx.query("SELECT c.lesson_id FROM bot_curriculum c JOIN lessons l ON l.id=c.lesson_id JOIN evidence e ON e.id=l.evidence_id JOIN sources s ON s.id=e.source_id WHERE c.bot_id=$1 AND (l.status<>'verified' OR e.status<>'verified' OR s.approved=false)",[botId]);
    const invalidEvaluation=await tx.query("SELECT x.id FROM experiments x JOIN datasets d ON d.id=x.dataset_id JOIN evidence e ON e.id=d.evidence_id JOIN sources s ON s.id=e.source_id WHERE x.bot_id=$1 AND x.state='passed' AND (e.status<>'verified' OR s.approved=false)",[botId]);
    requireThat(!invalidLessons.rows.length&&!invalidEvaluation.rows.length,'Qualification evidence has been revoked');
  }
  reserve(actor:Actor,key:string,raw:unknown) {
    permit(actor,'trader');const input=parse(z.object({botId:id,symbol,side:z.enum(['buy','sell']),quantity:z.number().int().min(1).max(1000000),evidenceId:z.uuid()}).strict(),raw);
    return this.db.command(actor,'reserve-order',key,input,async tx=>{
      const bot=await this.tradingBot(tx,actor,input.botId);await verifiedEvidence(tx,input.evidenceId);
      const price=await this.price(tx,input.symbol,input.side),gross=bounded(price*BigInt(input.quantity)),fee=ceilBps(gross,this.config.feeBps);
      let reserved=0n;
      if(input.side==='buy') {
        await this.permitNewRisk(tx,bot.id);reserved=bounded(gross+fee);
        requireThat(reserved<=this.config.maxOrder,'Order exceeds configured limit');requireThat(await available(tx)>=reserved,'Insufficient shared available capital');
        const allReserved=BigInt((await tx.query("SELECT COALESCE(SUM(reserved_paise),0)::text AS value FROM orders WHERE status='reserved'")).rows[0]!.value);
        requireThat(await balance(tx,'POSITION')+allReserved+reserved<=this.config.maxExposure,'Organisation exposure limit exceeded');
        const ownCost=BigInt((await tx.query('SELECT COALESCE(SUM(cost_paise),0)::text AS value FROM positions WHERE bot_id=$1',[bot.id])).rows[0]!.value);
        const ownReserved=BigInt((await tx.query("SELECT COALESCE(SUM(reserved_paise),0)::text AS value FROM orders WHERE bot_id=$1 AND status='reserved'",[bot.id])).rows[0]!.value);
        requireThat(ownCost+ownReserved+reserved<=BigInt(bot.budget),'Bot budget exceeded');
      } else {
        const position=(await tx.query('SELECT quantity::text FROM positions WHERE bot_id=$1 AND symbol=$2',[bot.id,input.symbol])).rows[0];
        const pending=BigInt((await tx.query("SELECT COALESCE(SUM(quantity),0)::text AS value FROM orders WHERE bot_id=$1 AND symbol=$2 AND side='sell' AND status='reserved'",[bot.id,input.symbol])).rows[0]!.value);
        requireThat(position&&BigInt(position.quantity)-pending>=BigInt(input.quantity),'Insufficient unreserved position');
      }
      const orderId=uuid();await tx.query("INSERT INTO orders(id,bot_id,symbol,side,quantity,reserved_paise,evidence_id,status) VALUES($1,$2,$3,$4,$5,$6,$7,'reserved')",[orderId,bot.id,input.symbol,input.side,input.quantity,reserved.toString(),input.evidenceId]);
      await audit(tx,actor,'paper.order.reserved',orderId,{...input,reservedPaise:reserved.toString()});return {id:orderId,state:'reserved',reservedPaise:reserved.toString()};
    });
  }
  fill(actor:Actor,key:string,raw:unknown) {
    permit(actor,'trader');const input=parse(z.object({orderId:z.uuid()}).strict(),raw);
    return this.db.command(actor,'fill-order',key,input,async tx=>{
      const order=(await tx.query('SELECT *,quantity::text AS qty,reserved_paise::text AS reserved FROM orders WHERE id=$1',[input.orderId])).rows[0];requireThat(order,'Order not found',404);
      const bot=await this.tradingBot(tx,actor,order.bot_id);requireThat(order.status==='reserved','Order is not reserved');await verifiedEvidence(tx,order.evidence_id);
      const price=await this.price(tx,order.symbol,order.side),quantity=BigInt(order.qty),gross=bounded(price*quantity),fee=ceilBps(gross,this.config.feeBps);
      const position=(await tx.query('SELECT quantity::text,cost_paise::text FROM positions WHERE bot_id=$1 AND symbol=$2',[order.bot_id,order.symbol])).rows[0];
      let positionQty=BigInt(position?.quantity??0),positionCost=BigInt(position?.cost_paise??0),journalId:string;
      if(order.side==='buy') {
        await this.permitNewRisk(tx,bot.id);requireThat(gross+fee<=BigInt(order.reserved),'Price moved beyond reservation; cancel and re-propose');
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
    });
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
