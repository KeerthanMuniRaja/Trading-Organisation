import test from 'node:test';
import assert from 'node:assert/strict';
import { owner,researcher,treasuryActor,fixture,key } from './helpers.js';

test('financial controls preserve contributions, allocation history, reservations and owner authority',async t=>{
  const f=await fixture();
  try {
    await t.test('initial deposit enters Wallet 1 only and duplicate request has one effect',async()=>{
      const request={action:'deposit',payload:{amountPaise:'1000000',bankReference:'bank-original'}};
      const approved=await f.approval(request),idempotency=key();
      const first=await f.treasury.ownerTransaction(owner,idempotency,approved);
      assert.deepEqual(await f.treasury.ownerTransaction(owner,idempotency,approved),first);
      const s=await f.treasury.snapshot(owner);assert.equal(s.wallet1Paise,'1000000');assert.equal(s.wallet2Paise,'0');assert.equal(s.realisedNetProfitPaise,'0');assert.equal(s.contributionPaise,'1000000');
      await assert.rejects(()=>f.treasury.ownerTransaction(owner,key(),approved),/Approval expired/);
      await assert.rejects(()=>f.treasury.ownerTransaction(owner,idempotency,{...approved,request:{...request,payload:{...request.payload,amountPaise:'2000000'}}}),/different input/);
      assert.throws(()=>f.treasury.ownerTransaction(owner,key(),{}),/Invalid request/);
    });
    await t.test('signature is bound to transaction and bots cannot transfer money',async()=>{
      const approval=await f.approval({action:'transfer',payload:{from:'W1',to:'W2',amountPaise:'100'}});
      await assert.rejects(()=>f.treasury.ownerTransaction(owner,key(),{...approval,request:{action:'transfer',payload:{from:'W1',to:'W2',amountPaise:'200'}}}),/does not match/);
      assert.throws(()=>f.treasury.ownerTransaction(researcher,key(),approval),/not permitted/);
      assert.throws(()=>f.treasury.allocate(researcher,key()),/not permitted/);
      await f.db.transaction(tx=>tx.query("UPDATE owner_challenges SET expires_at=now()-interval '1 second' WHERE id=$1",[approval.proof.challengeId]));
      await assert.rejects(()=>f.treasury.ownerTransaction(owner,key(),approval),/Approval expired/);
    });
    await t.test('concurrent allocation creates one obligation and reserves its 40 percent',async()=>{
      await f.result(100000n);
      const responses=await Promise.allSettled([f.treasury.allocate(treasuryActor,key()),f.treasury.allocate(treasuryActor,key())]);
      assert.equal(responses.filter(r=>r.status==='fulfilled').length,1);
      const success=responses.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<{allocationId:string}>;
      const pending=await f.treasury.snapshot(owner);assert.equal(pending.wallet1Paise,'1100000');assert.equal(pending.wallet2Paise,'0');assert.equal(pending.pendingDistributionPaise,'40000');assert.equal(pending.availablePaise,'1060000');
      const tooMuch=await f.approval({action:'transfer',payload:{from:'W1',to:'SBI',amountPaise:'1060001'}});
      await assert.rejects(()=>f.treasury.ownerTransaction(owner,key(),tooMuch),/Insufficient/);
      await f.treasury.confirm(treasuryActor,key(),{allocationId:success.value.allocationId});
      await f.treasury.confirm(treasuryActor,key(),{allocationId:success.value.allocationId});
      const s=await f.treasury.snapshot(owner);assert.equal(s.wallet1Paise,'1060000');assert.equal(s.wallet2Paise,'40000');
    });
    await t.test('loss recovery does not allocate the same profit again',async()=>{
      await f.result(-70000n);assert.equal((await f.treasury.snapshot(owner)).eligibleProfitPaise,'0');
      await assert.rejects(()=>f.treasury.allocate(treasuryActor,key()),/No new/);
      await f.result(70000n);await assert.rejects(()=>f.treasury.allocate(treasuryActor,key()),/No new/);
      await f.result(50000n);const a=await f.treasury.allocate(treasuryActor,key());assert.equal(a.basePaise,'50000');await f.treasury.confirm(treasuryActor,key(),{allocationId:a.allocationId});
      const s=await f.treasury.snapshot(owner);assert.equal(s.wallet1Paise,'1090000');assert.equal(s.wallet2Paise,'60000');assert.equal(s.allocatedProfitBasePaise,'150000');
    });
    await t.test('owner transfers and later deposits do not reset profit history',async()=>{
      await f.treasury.ownerTransaction(owner,key(),await f.approval({action:'transfer',payload:{from:'W2',to:'W1',amountPaise:'20000'}}));await f.deposit('200000');
      const s=await f.treasury.snapshot(owner);assert.equal(s.wallet1Paise,'1310000');assert.equal(s.wallet2Paise,'40000');assert.equal(s.realisedNetProfitPaise,'150000');assert.equal(s.allocatedProfitBasePaise,'150000');
    });
    await t.test('fractional split remainder carries forward without value loss',async()=>{
      await f.result(3n);await assert.rejects(()=>f.treasury.allocate(treasuryActor,key()),/No new/);
      await f.result(2n);const a=await f.treasury.allocate(treasuryActor,key());assert.equal(a.basePaise,'5');assert.equal(a.protectedPaise,'2');await f.treasury.confirm(treasuryActor,key(),{allocationId:a.allocationId});
    });
    await t.test('financial history is append-only and audit chain verifies',async()=>{
      await assert.rejects(()=>f.db.transaction(tx=>tx.query('UPDATE entries SET amount=0')),/append-only/);
      await assert.rejects(()=>f.db.transaction(tx=>tx.query('DELETE FROM audit_events')),/append-only/);
      assert.equal((await f.ops.verifyAudit(owner)).valid,true);
    });
    await t.test('database rejects an unbalanced journal at transaction commit',async()=>{
      await assert.rejects(()=>f.db.transaction(async tx=>{
        const journalId=crypto.randomUUID();await tx.query("INSERT INTO journals(id,kind,reference,metadata) VALUES($1,'invalid',$2,'{}')",[journalId,key()]);await tx.query("INSERT INTO entries(journal_id,account,amount) VALUES($1,'W1',1)",[journalId]);
      }),/Unbalanced/);
    });
  } finally {await f.db.close();}
});
