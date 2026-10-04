import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStarter, apiOrigin, roleCredentials, sha, validatePlan } from './organisation-starter.mjs';

const lock='a'.repeat(64),planHash='b'.repeat(64);
function plan() {
  const rows=(start,count)=>Array.from({length:count},(_,i)=>({timestamp:new Date(Date.UTC(2015,0,1+start+i)).toISOString(),returns:[.001,.002,.003,.004]}));
  return {schema:'organisation-starter-v1',createdAt:'2025-01-01T00:00:00Z',provenance:{package:'skfolio',version:'1.4.11',
    dependencyLockSha256:lock,loader:'load_sp500_dataset',priorUse:'Already used by the offline academy; not unseen evaluation data'},assets:['A','B','C','D'],
    windows:Array.from({length:9},(_,i)=>({training:rows(i*63,252),holdout:rows(252+i*63,63)}))};
}

function fakeApi({failOnce=false,enabled=false,revoked=false,withdrawAtEnd=false}={}) {
  const writes=[],receipts=new Map(),blueprints=[],models=[],known={evidence:[],lessons:[]};let next=0,failed=false;
  const supportedEngine={engine:'factual-reflection-v1'};
  if(revoked)models.push({id:'revoked',manifest_hash:sha(JSON.stringify(supportedEngine)),revoked:true});
  const read=route=>{
    if(route==='/health')return {mode:'paper',liveExecution:false};
    if(route==='/operations')return {control:{halted:false}};
    if(route==='/lifecycle')return {policy:{revision:0,rules:{enabled,minWindows:3}},students:[],blueprints};
    if(route==='/dispatch')return {policy:{revision:0,rules:{enabled:false,datasetIds:[]}}};
    if(route==='/learning')return {policy:{revision:0,enabled:false},supportedEngine,models};
    if(route==='/knowledge')return withdrawAtEnd?{evidence:[],lessons:[]}:known;
    throw new Error('Unexpected read '+route);
  };
  const api=async(role,route,body,key)=>{
    if(body===undefined)return structuredClone(read(route));
    const identity=role+':'+key;
    if(receipts.has(identity)){
      const saved=receipts.get(identity);assert.deepEqual(saved.body,body);return structuredClone(saved.result);
    }
    assert.ok(!route.includes('policy')&&!route.includes('treasury')&&!route.includes('orders')&&!route.includes('cycles'));
    const result={id:body.id??'record-'+(++next)};
    if(route==='/evidence')known.evidence.push({id:result.id});
    if(route==='/lessons')known.lessons.push({id:result.id});
    if(route==='/lifecycle/blueprints')blueprints.push({...body,state:'approved'});
    if(route==='/learning/models')models.push({id:result.id,manifest_hash:sha(JSON.stringify(supportedEngine)),revoked:false});
    receipts.set(identity,{body:structuredClone(body),result});writes.push({role,route,body,key});
    if(failOnce&&!failed&&route==='/portfolio/datasets'){failed=true;throw new Error('Lost response after commit');}
    return structuredClone(result);
  };
  return {api,writes};
}

test('starter rejects changed lock, extra instructions, repeated periods and malformed data before mutation',()=>{
  assert.equal(validatePlan(plan(),lock).windows.length,9);
  assert.throws(()=>validatePlan(plan(),'c'.repeat(64)),/lock differs/);
  assert.throws(()=>validatePlan({...plan(),commands:['withdraw']},lock));
  const overlap=plan();overlap.windows[1]=structuredClone(overlap.windows[0]);
  assert.throws(()=>validatePlan(overlap,lock),/overlap/);
  const wrong=plan();wrong.windows[0].training[0].returns=[1,2];
  assert.throws(()=>validatePlan(wrong,lock));
});

test('starter scopes credentials and rejects remote HTTP or embedded URL credentials',()=>{
  const principals=['owner','researcher','evaluator'].map(role=>({id:role,role,token:'token-'+role}));
  assert.equal(roleCredentials(principals).evaluator.id,'evaluator');
  assert.throws(()=>roleCredentials([...principals,principals[0]]),/Exactly one/);
  assert.throws(()=>roleCredentials(principals.map(p=>({...p,id:'same'}))),/distinct/);
  assert.throws(()=>apiOrigin('http://example.org'),/HTTPS/);
  assert.throws(()=>apiOrigin('https://token@example.org'),/HTTPS/);
  assert.equal(apiOrigin('http://127.0.0.1:3000'),'http://127.0.0.1:3000');
});

test('lost response recovery reuses identical receipts and never enables policies or starts workers',async()=>{
  const {api,writes}=fakeApi({failOnce:true});
  await assert.rejects(()=>applyStarter(plan(),planHash,api),/Lost response/);
  const result=await applyStarter(plan(),planHash,api),count=writes.length;
  assert.deepEqual(await applyStarter(plan(),planHash,api),result);assert.equal(writes.length,count);
  assert.equal(result.datasetIds.length,9);assert.equal(result.blueprints.length,3);
  assert.equal(result.activation.lifecycle.rules.maxLifetimeBots,3);
  assert.equal(result.activation.dispatch.rules.maxLifetimeAssignments,27);
  assert.ok(writes.filter(w=>w.route==='/evidence/reviews'||w.route==='/lessons/reviews').every(w=>w.role==='evaluator'));
  assert.ok(writes.filter(w=>w.route==='/evidence'||w.route==='/lessons').every(w=>w.role==='researcher'));
  assert.equal(writes.find(w=>w.route==='/bots').body.budgetPaise,'0');
});

test('active community policy and withdrawn support are not bypassed by starter setup',async()=>{
  for(const settings of [{enabled:true},{revoked:true}]){
    const {api,writes}=fakeApi(settings);
    await assert.rejects(()=>applyStarter(plan(),planHash,api));assert.equal(writes.length,0);
  }
  const {api}=fakeApi({withdrawAtEnd:true});
  await assert.rejects(()=>applyStarter(plan(),planHash,api),/cached receipts do not restore/);
});
