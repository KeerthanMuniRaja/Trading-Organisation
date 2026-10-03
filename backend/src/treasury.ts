import { z } from 'zod';
import { Config } from './config.js';
import { Actor, bounded, id, parse, permit, requireThat, uuid } from './core.js';
import { Database, Sql, audit } from './database.js';
import { OwnerAuthorization, ownerRequest } from './security.js';

export async function balance(tx: Sql, account: string) {
  return BigInt((await tx.query('SELECT COALESCE(SUM(amount),0)::text AS value FROM entries WHERE account=$1', [account])).rows[0]!.value);
}
export async function available(tx: Sql) {
  const reserved = BigInt((await tx.query("SELECT COALESCE(SUM(reserved_paise),0)::text AS value FROM orders WHERE status='reserved'")).rows[0]!.value);
  const distributions = BigInt((await tx.query("SELECT COALESCE(SUM(protected_amount),0)::text AS value FROM allocations WHERE status='pending'")).rows[0]!.value);
  return (await balance(tx, 'W1')) - reserved - distributions;
}
export async function journal(tx: Sql, kind: string, reference: string, metadata: unknown, amounts: Array<[string,bigint]>) {
  requireThat(amounts.reduce((sum, [,v]) => sum + v, 0n) === 0n, 'Unbalanced journal', 500);
  requireThat(!(await tx.query('SELECT id FROM journals WHERE reference=$1', [reference])).rows.length, 'Source event has already been recorded');
  const journalId = uuid();
  await tx.query('INSERT INTO journals (id,kind,reference,metadata) VALUES ($1,$2,$3,$4::jsonb)', [journalId, kind, reference, JSON.stringify(metadata)]);
  for (const [account, amount] of amounts) await tx.query('INSERT INTO entries (journal_id,account,amount) VALUES ($1,$2,$3)', [journalId,account,amount.toString()]);
  requireThat(await balance(tx, 'W1') >= 0n && await balance(tx, 'W2') >= 0n, 'Wallet cannot become negative');
  return journalId;
}
export class Treasury {
  constructor(private readonly db: Database, private readonly config: Config, private readonly auth: OwnerAuthorization) {}
  ownerTransaction(actor: Actor, key: string, raw: unknown) {
    permit(actor, 'owner'); const input = parse(ownerRequest, raw);
    return this.db.command(actor, 'owner-transaction', key, input.request, async tx => {
      await this.auth.consume(tx, actor, input);
      const { action, payload } = input.request;
      const amount = bounded(BigInt(payload.amountPaise));
      let journalId: string;
      if (action === 'deposit') {
        journalId = await journal(tx, 'owner-contribution', 'deposit:' + payload.bankReference, { source: 'SBI', mode: 'paper' }, [['W1',amount], ['PRINCIPAL',-amount]]);
      } else if (action === 'expense') {
        requireThat(await available(tx) >= amount, 'Insufficient available Wallet 1 funds');
        journalId = await journal(tx, 'operating-expense', 'expense:' + payload.reference, { category: payload.category, mode: 'paper' }, [['W1',-amount],['PNL',amount]]);
      } else {
        const spendable = payload.from === 'W1' ? await available(tx) : await balance(tx,'W2');
        requireThat(spendable >= amount, 'Insufficient available funds');
        journalId = await journal(tx, 'owner-transfer', 'owner:' + input.proof.challengeId, { from: payload.from, to: payload.to, mode: 'paper' }, [[payload.from,-amount],[payload.to === 'SBI' ? 'WITHDRAWN' : payload.to,amount]]);
      }
      await audit(tx, actor, 'paper.owner.' + action, journalId, { request: input.request, approval: input.proof.challengeId });
      return { journalId, mode: 'paper' };
    });
  }
  snapshot(actor: Actor) {
    permit(actor, 'owner', 'treasury');
    return this.db.transaction(async tx => {
      const pnl = -(await balance(tx,'PNL'));
      const a = BigInt((await tx.query('SELECT COALESCE(SUM(profit_base),0)::text AS value FROM allocations')).rows[0]!.value);
      const pending = BigInt((await tx.query("SELECT COALESCE(SUM(protected_amount),0)::text AS value FROM allocations WHERE status='pending'")).rows[0]!.value);
      return {
        mode: 'paper', currency: 'INR', units: 'paise', wallet1Paise: (await balance(tx,'W1')).toString(), wallet2Paise: (await balance(tx,'W2')).toString(),
        availablePaise: (await available(tx)).toString(), contributionPaise: (-(await balance(tx,'PRINCIPAL'))).toString(),
        withdrawnPaise: (await balance(tx,'WITHDRAWN')).toString(), positionCostPaise: (await balance(tx,'POSITION')).toString(),
        realisedNetProfitPaise: pnl.toString(), allocatedProfitBasePaise: a.toString(), eligibleProfitPaise: (pnl > a ? pnl-a : 0n).toString(), pendingDistributionPaise: pending.toString(),
        policy: { retainedPercent: 60, protectedPercent: 40, liveEnabled: false, allocationRequiresFlatPositions: true },
      };
    });
  }
  allocate(actor: Actor, key: string) {
    permit(actor, 'treasury');
    return this.db.command(actor,'allocate',key,{},async tx => {
      requireThat(!(await tx.query('SELECT halted FROM system_lock WHERE id=1')).rows[0]!.halted, 'System halted');
      requireThat(!(await tx.query("SELECT id FROM orders WHERE status='reserved' LIMIT 1")).rows.length && !(await tx.query('SELECT bot_id FROM positions WHERE quantity>0 LIMIT 1')).rows.length, 'Close paper positions and outstanding orders before distribution');
      const pnl = -(await balance(tx,'PNL'));
      const a = BigInt((await tx.query('SELECT COALESCE(SUM(profit_base),0)::text AS value FROM allocations')).rows[0]!.value);
      const eligible = pnl > a ? pnl-a : 0n;
      // Allocate only whole blocks of five paise, preserving the exact 60/40 ratio.
      // A remainder stays unallocated for the next run; it is not rounded away.
      const base = eligible - eligible % 5n;
      requireThat(base > 0n, 'No new distributable profit');
      const protectedAmount = base*2n/5n;
      requireThat(await available(tx) >= protectedAmount, 'Insufficient settled available funds');
      const allocationId = uuid();
      await tx.query("INSERT INTO allocations (id,profit_base,protected_amount,status) VALUES ($1,$2,$3,'pending')", [allocationId,base.toString(),protectedAmount.toString()]);
      await audit(tx,actor,'profit.allocated',allocationId,{ basePaise: base.toString(), retainedPaise: (base-protectedAmount).toString(), protectedPaise: protectedAmount.toString() });
      return { allocationId, state: 'pending', basePaise: base.toString(), protectedPaise: protectedAmount.toString() };
    });
  }
  confirm(actor: Actor, key: string, raw: unknown) {
    permit(actor,'treasury'); const input = parse(z.object({ allocationId:z.uuid() }).strict(),raw);
    return this.db.command(actor,'confirm-allocation',key,input,async tx => {
      const allocation = (await tx.query('SELECT *, protected_amount::text AS amount FROM allocations WHERE id=$1', [input.allocationId])).rows[0];
      requireThat(allocation, 'Allocation not found',404);
      if (allocation.status === 'confirmed') return { allocationId: allocation.id, state:'confirmed',mode:'paper' };
      const amount = BigInt(allocation.amount);
      await journal(tx,'profit-transfer','allocation:'+allocation.id,{mode:'paper'},[['W1',-amount],['W2',amount]]);
      await tx.query("UPDATE allocations SET status='confirmed',confirmed_at=now() WHERE id=$1",[allocation.id]);
      await audit(tx,actor,'paper.profit.transfer.confirmed',allocation.id,{amountPaise:amount.toString()});
      return { allocationId:allocation.id,state:'confirmed',mode:'paper' };
    });
  }
  history(actor:Actor) {
    permit(actor,'owner');
    return this.db.transaction(async tx => (await tx.query('SELECT j.*,e.account,e.amount::text FROM journals j JOIN entries e ON e.journal_id=j.id ORDER BY j.created_at DESC,e.id DESC LIMIT 500')).rows);
  }
}
