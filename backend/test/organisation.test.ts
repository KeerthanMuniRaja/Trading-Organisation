import test from 'node:test';
import assert from 'node:assert/strict';
import { owner,researcher,evaluator,trader,fixture,key,bars } from './helpers.js';

test('academy separates training, evaluation, permissions, and preserved knowledge',async t=>{
  const f=await fixture();
  try {
    const e=await f.evidence();
    await f.org.bot(owner,key(),{id:'bot-one',name:'Momentum student',department:'research',specialty:'daily-trend',method:'momentum-v1',contribution:'Test prior-close momentum with explicit costs',budgetPaise:'1000000'});
    const lesson=await f.org.lesson(researcher,key(),{botId:'bot-one',evidenceId:e.evidenceId,content:'Use only prior observations for signals; record failed trials.'});
    await t.test('independent evidence and lessons are required for school',async()=>{
      await assert.rejects(()=>f.org.school(owner,key(),{botId:'bot-one',lessonIds:[lesson.id]}),/Verified lesson/);
      await f.org.verifyLesson(evaluator,key(),{lessonId:lesson.id});await f.org.school(owner,key(),{botId:'bot-one',lessonIds:[lesson.id]});
      assert.equal((await f.org.list(owner))[0]!.state,'college');
      await assert.rejects(()=>f.paper.reserve(trader,key(),{botId:'bot-one',symbol:'DEMO',side:'buy',quantity:1,evidenceId:e.evidenceId}),/not qualified/);
    });
    await t.test('renamed duplicates do not pass declared capability admission',async()=>{
      await assert.rejects(()=>f.org.bot(owner,key(),{id:'copy',name:'Copy',department:'RESEARCH',specialty:'DAILY-TREND',method:'MOMENTUM-V1',contribution:'same work',budgetPaise:'100'}),/already exists/);
    });
    const dataset=await f.research.dataset(owner,key(),{evidenceId:e.evidenceId,training:bars(60,10000),holdout:bars(60,16000,60)});
    await f.research.experiment(researcher,key(),{botId:'bot-one',datasetId:dataset.id,hypothesis:'Prior-close momentum may beat cash after costs'});
    await t.test('coordinator sees task identity and progress without research data or authority',async()=>{
      const tasks=await f.research.coordination({id:'coordinator',role:'coordinator'});
      assert.equal(tasks.length,1);
      assert.deepEqual(Object.keys(tasks[0]!).sort(),['bot_id','created_at','hypothesis','id','state']);
      assert.equal(tasks[0]!.state,'queued');
      assert.throws(()=>f.research.claim({id:'coordinator',role:'coordinator'}),/not permitted/);
      assert.throws(()=>f.research.reports({id:'coordinator',role:'coordinator'}),/not permitted/);
    });
    let researchJob:any;
    await t.test('researcher receives training only; abandoned lease can be reclaimed',async()=>{
      const claimed=await f.research.claim(researcher);researchJob=claimed.job;assert.ok(researchJob);assert.equal(researchJob.payload.holdout,undefined);assert.equal(researchJob.payload.training.length,60);
      const oldToken=researchJob.leaseToken;await f.db.transaction(tx=>tx.query("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[researchJob.id]));
      researchJob=(await f.research.claim(researcher)).job;assert.notEqual(researchJob.leaseToken,oldToken);
      await assert.rejects(()=>f.research.complete(researcher,key(),{jobId:researchJob.id,leaseToken:oldToken,result:{candidate:{kind:'momentum',lookback:2},trainingReport:{selectedScoreBps:10,trials:[{lookback:2,netReturnBps:10}]}}}),/lease is not valid/);
    });
    await t.test('research completion creates a separate evaluator job',async()=>{
      await f.research.complete(researcher,key(),{jobId:researchJob.id,leaseToken:researchJob.leaseToken,result:{candidate:{kind:'momentum',lookback:2},trainingReport:{selectedScoreBps:10,trials:[{lookback:2,netReturnBps:10}]}}});
      assert.equal((await f.research.claim(researcher)).job,null);assert.equal((await f.org.list(owner))[0]!.state,'college');
      assert.throws(()=>f.research.reports(researcher),/not permitted/);
    });
    await t.test('only the evaluator contract can qualify for paper operation',async()=>{
      const job=(await f.research.claim(evaluator)).job!;
      const result={observations:60,netReturnBps:100,baselineReturnBps:0,maxDrawdownBps:50,turnover:2,costBps:15,datasetDigest:dataset.digest};
      assert.throws(()=>f.research.complete(evaluator,key(),{jobId:job.id,leaseToken:job.leaseToken,result:{...result,costBps:0}}),/Invalid request/);
      await f.research.complete(evaluator,key(),{jobId:job.id,leaseToken:job.leaseToken,result});assert.equal((await f.org.list(owner))[0]!.state,'paper');
      await assert.rejects(()=>f.research.experiment(researcher,key(),{botId:'bot-one',datasetId:dataset.id,hypothesis:'Try same test again'}),/college candidate/);
    });
    await t.test('retirement preserves reviewed lessons and removes trading eligibility',async()=>{
      await f.org.retire(owner,key(),{botId:'bot-one',reason:'Retirement exercise',transferLessonIds:[lesson.id]});
      assert.equal((await f.org.knowledge(researcher)).lessons[0]!.id,lesson.id);
      await assert.rejects(()=>f.paper.reserve(trader,key(),{botId:'bot-one',symbol:'DEMO',side:'buy',quantity:1,evidenceId:e.evidenceId}),/not qualified/);
      assert.equal((await f.ops.verifyAudit(owner)).valid,true);
    });
  } finally {await f.db.close();}
});
