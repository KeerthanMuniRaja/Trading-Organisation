import test from 'node:test';
import assert from 'node:assert/strict';
import { PortfolioResearch, portfolioScore } from '../src/portfolio.js';
import { createApp } from '../src/app.js';
import { owner,researcher,evaluator,trader,fixture,key } from './helpers.js';

const returns=(count:number,offset=0,value=0)=>Array.from({length:count},(_,i)=>({timestamp:new Date(Date.UTC(2020,0,1+i+offset)).toISOString(),returns:[value,value,value,value]}));
async function setup(){
  const f=await fixture(),portfolio=new PortfolioResearch(f.db);
  try {
    const evidence=await f.evidence();
    await f.org.bot(owner,key(),{id:'bot-one',name:'Portfolio student',department:'research',specialty:'allocation',method:'portfolio-v1',contribution:'Compare constrained allocations',budgetPaise:'0'});
    const lesson=await f.org.lesson(researcher,key(),{botId:'bot-one',evidenceId:evidence.evidenceId,content:'Preserve every attempt; future observations cannot enter fitting.'});
    await f.org.verifyLesson(evaluator,key(),{lessonId:lesson.id});
    await f.org.school(owner,key(),{botId:'bot-one',lessonIds:[lesson.id]});
    const input={evidenceId:evidence.evidenceId,purpose:'example-testing',assets:['A','B','C','D'],training:returns(60),holdout:returns(20,60,.001)};
    const dataset=await portfolio.dataset(owner,key(),input);
    const proposal={botId:'bot-one',datasetId:dataset.id,datasetDigest:dataset.digest,method:'equal_weight',weights:[.25,.25,.25,.25]};
    return {...f,portfolio,evidence,input,dataset,proposal,lesson};
  }catch(error){await f.db.close();throw error;}
}

test('portfolio scorer charges both costs and holds drifting quantities',()=>{
  const flat=portfolioScore([.25,.25,.25,.25],returns(20));
  assert.ok(Math.abs(flat.netReturnBps-(.9985**2-1)*10000)<1e-8);
  assert.ok(Math.abs(flat.maxDrawdownBps+flat.netReturnBps)<1e-8);
  const varying=returns(2).map(r=>({...r,returns:[1,-.5,0,0]}));
  assert.ok(Math.abs(portfolioScore([.25,.25,.25,.25],varying).netReturnBps-(1.5625*.9985**2-1)*10000)<1e-8);
});

test('portfolio evaluation is independent, backend-calculated, notified and never graduates example data',async()=>{
  const f=await setup();
  try {
    const training=await f.portfolio.training(researcher,{datasetId:f.dataset.id});
    assert.equal(training.training.length,60);assert.equal('holdout' in training,false);
    assert.throws(()=>f.portfolio.reports(researcher),/not permitted/);
    const submitKey=key(),trial=await f.portfolio.submit(researcher,submitKey,f.proposal);
    assert.deepEqual(await f.portfolio.submit(researcher,submitKey,f.proposal),trial);
    await assert.rejects(()=>f.portfolio.submit(researcher,key(),f.proposal),/already submitted/);
    assert.throws(()=>f.portfolio.review(researcher,key(),{trialId:trial.id}),/not permitted/);
    await assert.rejects(()=>f.portfolio.review({id:researcher.id,role:'evaluator'},key(),{trialId:trial.id}),/Independent/);
    assert.throws(()=>f.portfolio.review(evaluator,key(),{trialId:trial.id,netReturnBps:99999}),/Invalid request/);
    const reviewKey=key(),review=await f.portfolio.review(evaluator,reviewKey,{trialId:trial.id});
    assert.equal(review.report.calculatedBy,'backend');assert.equal(review.report.rewardBps,0);
    assert.equal(review.report.promotionAllowed,false);assert.ok(review.report.netReturnBps>0);
    assert.deepEqual(await f.portfolio.review(evaluator,reviewKey,{trialId:trial.id}),review);
    assert.equal((await f.org.list(owner))[0]!.state,'college');
    assert.equal((await f.treasury.snapshot(owner)).wallet1Paise,'0');
    assert.equal((await f.treasury.snapshot(owner)).wallet2Paise,'0');
    assert.equal((await f.ops.status(owner)).notifications.filter(n=>n.summary.startsWith('portfolio.trial.evaluated')).length,1);
    assert.equal((await f.ops.verifyAudit(owner)).valid,true);
  }finally{await f.db.close();}
});

test('portfolio input rejects leakage, forged results, invalid dimensions and concentration',async()=>{
  const f=await setup();
  try {
    assert.throws(()=>f.portfolio.dataset(owner,key(),{...f.input,holdout:returns(20)}),/Training must precede/);
    assert.throws(()=>f.portfolio.dataset(owner,key(),{...f.input,purpose:'live-trading'}),/Invalid request/);
    assert.throws(()=>f.portfolio.dataset(owner,key(),{...f.input,assets:['A','A','C','D']}),/Invalid request/);
    assert.throws(()=>f.portfolio.dataset(owner,key(),{...f.input,training:f.input.training.map(r=>({...r,returns:[.1]}))}),/Invalid request/);
    assert.throws(()=>f.portfolio.submit(researcher,key(),{...f.proposal,weights:[.9,.05,.025,.025]}),/Invalid request/);
    assert.throws(()=>f.portfolio.submit(researcher,key(),{...f.proposal,weights:[.2,.2,.2,.2]}),/sum to one/);
    await assert.rejects(()=>f.portfolio.submit(researcher,key(),{...f.proposal,datasetDigest:'a'.repeat(64)}),/contract mismatch/);
    const ordered={...f.input,assets:['D','C','B','A'],training:f.input.training.map(r=>({...r,returns:r.returns.slice().reverse()})),holdout:f.input.holdout.map(r=>({...r,returns:r.returns.slice().reverse()}))};
    await assert.rejects(()=>f.portfolio.dataset(owner,key(),ordered),/already registered/);
    const newTraining={...f.input,training:returns(60,0,.002)};
    const different=await f.portfolio.dataset(owner,key(),newTraining);
    await f.portfolio.submit(researcher,key(),f.proposal);
    await assert.rejects(()=>f.portfolio.submit(researcher,key(),{...f.proposal,datasetId:different.id,datasetDigest:different.digest}),/exact holdout/);
  }finally{await f.db.close();}
});

test('portfolio evidence revocation closes pending work and preserves historical results',async()=>{
  const f=await setup();
  try {
    const evaluated=await f.portfolio.submit(researcher,key(),f.proposal);
    await f.portfolio.review(evaluator,key(),{trialId:evaluated.id});
    const pending=await f.portfolio.submit(researcher,key(),{...f.proposal,method:'minimum_variance'});
    await f.org.revoke(owner,key(),{kind:'source',targetId:f.evidence.sourceId,reason:'Fixture source withdrawn'});
    await assert.rejects(()=>f.portfolio.training(researcher,{datasetId:f.dataset.id}),/Verified evidence/);
    await assert.rejects(()=>f.portfolio.review(evaluator,key(),{trialId:pending.id}),/not awaiting/);
    const reports=await f.portfolio.reports(owner);
    assert.equal(reports.find(r=>r.id===pending.id)!.state,'revoked');
    assert.equal(reports.find(r=>r.id===evaluated.id)!.state,'evaluated');
    assert.ok(reports.every(r=>!r.evidence_active));
  }finally{await f.db.close();}
});

test('owner cancels pending portfolio work before retirement, without erasing trials',async()=>{
  const f=await setup();
  try {
    const trial=await f.portfolio.submit(researcher,key(),f.proposal);
    const retirement={botId:'bot-one',reason:'Retire fixture',transferLessonIds:[f.lesson.id]};
    await assert.rejects(()=>f.org.retire(owner,key(),retirement),/Resolve portfolio/);
    assert.throws(()=>f.portfolio.cancel(researcher,key(),{trialId:trial.id,reason:'skip review'}),/not permitted/);
    await f.portfolio.cancel(owner,key(),{trialId:trial.id,reason:'End fixture work'});
    await f.org.retire(owner,key(),retirement);
    await assert.rejects(()=>f.portfolio.review(evaluator,key(),{trialId:trial.id}),/not awaiting/);
    assert.equal((await f.portfolio.reports(owner))[0]!.state,'cancelled');
  }finally{await f.db.close();}
});

test('HTTP portfolio boundary denies researcher holdout reports, forged metrics and trader authority',async()=>{
  const f=await setup(),app=await createApp(f.cfg,f.db,true);
  try {
    await app.listen(0,'127.0.0.1');const base=await app.getUrl();
    const call=(path:string,role:string,body?:unknown)=>fetch(base+'/v1/portfolio/'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key(),Authorization:'Bearer '+f.cfg.principals.find(p=>p.role===role)!.token},...(body===undefined?{}:{body:JSON.stringify(body)})});
    assert.equal((await call('trials','researcher')).status,403);
    assert.equal((await call('datasets','researcher',f.input)).status,403);
    assert.equal((await call('trials','trader',f.proposal)).status,403);
    const training=await call('training','researcher',{datasetId:f.dataset.id});assert.equal(training.status,201);
    const trainingBody=await training.json() as Record<string,unknown>;
    assert.equal('holdout' in trainingBody,false);
    const trial=await (await call('trials','researcher',f.proposal)).json() as {id:string};
    assert.equal((await call('reviews','evaluator',{trialId:trial.id,report:{netReturnBps:9999}})).status,400);
    assert.equal((await call('reviews','evaluator',{trialId:trial.id})).status,201);
  }finally{await app.close();await f.db.close();}
});
