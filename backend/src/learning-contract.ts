import { digest, requireThat } from './core.js';
import { Row, Sql } from './database.js';

// This is a versioned deterministic reflection engine, not a language model.
// Changes to the wording/contract require a newly approved model profile.
export const reflectionManifest={engine:'factual-reflection-v1',version:1,
  inputs:['trialId','method','observations','relativeRewardSign'],
  template:'Example research trial {trialId}, method {method}, used {observations} held-out observations. Its cost-and-drawdown-adjusted diagnostic score was {comparison} the equal-weight baseline. This records one historical test, not a causal explanation or a generally successful strategy. Do not reuse this holdout for another fitness reward. No trading permission or profit entitlement follows.',
  comparisons:{positive:'above',neutral:'equal to',negative:'below'},
  scope:'example-research-memory',tools:[],hostedInference:false};
export const reflectionHash=digest(reflectionManifest);

export function reflectTrial(trial:Row) {
  const r=trial.report;
  requireThat(trial.state==='evaluated'&&r?.policy==='portfolio-example-v1'&&r.calculatedBy==='backend'&&r.promotionAllowed===false
    &&r.purpose==='example-testing'&&r.datasetDigest===trial.dataset_digest
    &&Number.isFinite(r.rewardBps)&&Number.isInteger(r.observations)&&r.observations>=20&&r.observations<=126,
    'Only supported backend example reports may produce memory');
  requireThat(['equal_weight','inverse_volatility','minimum_variance'].includes(trial.method),'Unsupported research method');
  const outcome=r.rewardBps>0?'positive':r.rewardBps<0?'negative':'neutral';
  return reflectionManifest.template.replace('{trialId}',trial.id).replace('{method}',trial.method)
    .replace('{observations}',String(r.observations)).replace('{comparison}',reflectionManifest.comparisons[outcome]);
}

export async function sharedResearchMemory(tx:Sql,method?:string,botId?:string,before?:string) {
  const rows=(await tx.query(`SELECT p.id,p.bot_id,p.trial_id,p.model_id,p.content,p.report_hash,p.created_at,
    t.method,t.state,t.report,d.digest AS dataset_digest,r.reviewer,m.manifest_hash
    FROM learning_proposals p JOIN learning_reviews r ON r.proposal_id=p.id
    JOIN learning_models m ON m.id=p.model_id JOIN portfolio_trials t ON t.id=p.trial_id
    JOIN portfolio_datasets d ON d.id=t.dataset_id JOIN evidence e ON e.id=d.evidence_id JOIN sources s ON s.id=e.source_id
    WHERE r.decision='verified' AND e.status='verified' AND s.approved=true AND t.state='evaluated'
    AND NOT EXISTS(SELECT 1 FROM learning_model_revocations v WHERE v.model_id=m.id)
    AND m.manifest_hash=$1 AND ($2::text IS NULL OR t.method=$2) AND ($3::text IS NULL OR p.bot_id=$3)
    AND ($4::timestamptz IS NULL OR (d.holdout-> -1->>'timestamp')::timestamptz<$4::timestamptz)
    ORDER BY r.created_at DESC,p.id LIMIT 100`,[reflectionHash,method??null,botId??null,before??null])).rows;
  return rows.filter(row=>{
    try{return digest(row.report)===row.report_hash&&row.content===reflectTrial({...row,id:row.trial_id});}catch{return false;}
  }).map(row=>({id:row.id,botId:row.bot_id,trialId:row.trial_id,method:row.method,modelId:row.model_id,
    content:row.content,reviewer:row.reviewer,createdAt:row.created_at,scope:'example-research-memory'}));
}
