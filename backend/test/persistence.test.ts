import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from '../src/database.js';
import { Treasury,journal } from '../src/treasury.js';
import { OwnerAuthorization } from '../src/security.js';
import { config,owner,treasuryActor,key } from './helpers.js';

test('durable database preserves a pending allocation and safe retry across restart',async()=>{
  const path=join(await mkdtemp(join(tmpdir(),'trading-organisation-test-')),'nested','paper');
  const {cfg}=config();let db=await Database.open(path);let service=new Treasury(db,cfg,new OwnerAuthorization(db,cfg));
  await db.transaction(async tx=>{
    await journal(tx,'fixture-contribution','persistent-capital',{},[['W1',100000n],['PRINCIPAL',-100000n]]);
    await journal(tx,'fixture-profit','persistent-profit',{},[['W1',10000n],['PNL',-10000n]]);
  });
  const allocation=await service.allocate(treasuryActor,'persistent-allocation');await db.close();
  db=await Database.open(path);service=new Treasury(db,cfg,new OwnerAuthorization(db,cfg));
  try {
    const before=await service.snapshot(owner);assert.equal(before.pendingDistributionPaise,'4000');assert.equal(before.allocatedProfitBasePaise,'10000');assert.equal(before.availablePaise,'106000');
    assert.deepEqual(await service.allocate(treasuryActor,'persistent-allocation'),allocation);
    await service.confirm(treasuryActor,key(),{allocationId:allocation.allocationId});
    assert.equal((await service.snapshot(owner)).wallet2Paise,'4000');
  }finally{await db.close();}
});
