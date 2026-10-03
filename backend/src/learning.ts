import { z } from 'zod';
import { Actor, digest, id, parse, permit, requireThat, text, uuid } from './core.js';
import { Database, audit } from './database.js';
import { reflectionHash, reflectionManifest, reflectTrial, sharedResearchMemory } from './learning-contract.js';
import { verifiedEvidence } from './organisation.js';
import { BotKnowledge } from './bot-knowledge.js';
import { KnowledgeAssessments } from './knowledge-assessments.js';
import { SourceLearning } from './source-learning.js';
import { LearningWorkflows } from './learning-workflows.js';

export class OrganisationalLearning {
  constructor(private readonly db:Database) {}
  knowledge(){return new BotKnowledge(this.db);}
  knowledgeAssessments(){return new KnowledgeAssessments(this.db);}
  sourceLearning(){return new SourceLearning(this.db);}
  workflows(){return new LearningWorkflows(this.db);}

  register(actor:Actor,key:string,raw:unknown) {
    permit(actor,'owner');const input=parse(z.object({id,name:text,engine:z.literal('factual-reflection-v1')}).strict(),raw);
    return this.db.command(actor,'learning-model',key,input,async tx=>{
      requireThat((await tx.query('SELECT count(*)::int AS count FROM learning_models')).rows[0]!.count<100,'Model registry capacity reached');
      await tx.query('INSERT INTO learning_models(id,name,engine,manifest_hash,manifest,approved_by) VALUES($1,$2,$3,$4,$5::jsonb,$6)',
        [input.id,input.name,input.engine,reflectionHash,JSON.stringify(reflectionManifest),actor.id]);
      await audit(tx,actor,'learning.model.approved',input.id,{engine:input.engine,manifestHash:reflectionHash});
      return {id:input.id,engine:input.engine,manifestHash:reflectionHash,hostedInference:false};
    });
  }

  revoke(actor:Actor,key:string,raw:unknown) {
    permit(actor,'owner');const input=parse(z.object({modelId:id,reason:text}).strict(),raw);
    return this.db.command(actor,'learning-model-revoke',key,input,async tx=>{
      requireThat((await tx.query('SELECT id FROM learning_models WHERE id=$1',[input.modelId])).rows.length,'Model profile not found',404);
      const previous=(await tx.query('SELECT model_id FROM learning_model_revocations WHERE model_id=$1',[input.modelId])).rows[0];
      if(!previous){
        await tx.query('INSERT INTO learning_model_revocations(model_id,reason,actor) VALUES($1,$2,$3)',[input.modelId,input.reason,actor.id]);
        await audit(tx,actor,'learning.model.revoked',input.modelId,{reason:input.reason});
      }
      return {modelId:input.modelId,revoked:true};
    });
  }

  configure(actor:Actor,key:string,raw:unknown) {
    permit(actor,'owner');const input=parse(z.object({expectedRevision:z.number().int().nonnegative(),enabled:z.boolean(),modelId:id.nullable(),
      maxPerDay:z.number().int().min(1).max(100),maxLifetime:z.number().int().min(1).max(1000)}).strict(),raw);
    return this.db.command(actor,'learning-policy',key,input,async tx=>{
      const policy=(await tx.query('SELECT revision FROM learning_policy WHERE id=1')).rows[0]!;
      requireThat(policy.revision===input.expectedRevision,'Learning policy revision changed');
      if(input.modelId!==null)requireThat((await tx.query('SELECT id FROM learning_models WHERE id=$1',[input.modelId])).rows.length,'Model profile not found');
      if(input.enabled)requireThat((await tx.query(`SELECT m.id FROM learning_models m WHERE m.id=$1 AND m.manifest_hash=$2
        AND NOT EXISTS(SELECT 1 FROM learning_model_revocations v WHERE v.model_id=m.id)`,[input.modelId,reflectionHash])).rows.length,'Approve a current supported model profile first');
      await tx.query('UPDATE learning_policy SET revision=revision+1,enabled=$1,model_id=$2,max_per_day=$3,max_lifetime=$4 WHERE id=1',
        [input.enabled,input.modelId,input.maxPerDay,input.maxLifetime]);
      await audit(tx,actor,'learning.policy.changed','research-learning',{...input,revision:policy.revision+1});
      return {revision:policy.revision+1};
    });
  }

  cycle(actor:Actor,key:string,raw:unknown) {
    permit(actor,'researcher','evaluator');const input=parse(z.object({}).strict(),raw);
    return this.db.command(actor,'learning-cycle',key,input,async tx=>{
      const policy=(await tx.query('SELECT * FROM learning_policy WHERE id=1')).rows[0]!;
      if(!policy.enabled)return {status:'disabled',actions:[]};
      if((await tx.query('SELECT halted FROM system_lock WHERE id=1')).rows[0]!.halted)return {status:'halted',actions:[]};
      const actions:Record<string,unknown>[]=[];
      if(actor.role==='researcher'){
        const model=(await tx.query(`SELECT m.id FROM learning_models m WHERE m.id=$1 AND m.manifest_hash=$2
          AND NOT EXISTS(SELECT 1 FROM learning_model_revocations v WHERE v.model_id=m.id)`,[policy.model_id,reflectionHash])).rows[0];
        if(!model)return {status:'model-unavailable',actions};
        const counts=(await tx.query(`SELECT count(*)::int AS total,count(*) FILTER(WHERE created_at>now()-interval '24 hours')::int AS recent FROM learning_proposals`)).rows[0]!;
        const limit=Math.max(0,Math.min(10,policy.max_per_day-counts.recent,policy.max_lifetime-counts.total));
        if(!limit)return {status:'capacity-reached',actions};
        // One memory proposal per completed assigned trial, across all model/policy versions.
        const trials=(await tx.query(`SELECT t.*,d.digest AS dataset_digest FROM portfolio_trials t
          JOIN research_assignments a ON a.trial_id=t.id JOIN portfolio_datasets d ON d.id=t.dataset_id
          JOIN evidence e ON e.id=d.evidence_id JOIN sources s ON s.id=e.source_id
          WHERE t.state='evaluated' AND e.status='verified' AND s.approved=true
          AND NOT EXISTS(SELECT 1 FROM learning_proposals p WHERE p.trial_id=t.id)
          ORDER BY t.reviewed_at,t.id LIMIT $1`,[limit])).rows;
        for(const trial of trials){
          const content=reflectTrial(trial),proposalId=uuid();
          await tx.query('INSERT INTO learning_proposals(id,trial_id,bot_id,model_id,policy_revision,report_hash,content,author) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
            [proposalId,trial.id,trial.bot_id,model.id,policy.revision,digest(trial.report),content,actor.id]);
          await audit(tx,actor,'learning.memory.proposed',proposalId,{botId:trial.bot_id,trialId:trial.id,modelId:model.id,scope:'example-research-memory'});
          actions.push({proposalId,action:'proposed'});
        }
      }else{
        const proposals=(await tx.query(`SELECT p.*,t.state,t.method,t.report,d.digest AS dataset_digest,
          (e.status='verified' AND s.approved=true) AS evidence_active,m.manifest_hash,
          EXISTS(SELECT 1 FROM learning_model_revocations v WHERE v.model_id=m.id) AS model_revoked
          FROM learning_proposals p JOIN portfolio_trials t ON t.id=p.trial_id JOIN portfolio_datasets d ON d.id=t.dataset_id
          JOIN evidence e ON e.id=d.evidence_id JOIN sources s ON s.id=e.source_id JOIN learning_models m ON m.id=p.model_id
          WHERE p.author<>$1 AND NOT EXISTS(SELECT 1 FROM learning_reviews r WHERE r.proposal_id=p.id)
          ORDER BY p.created_at,p.id LIMIT 10`,[actor.id])).rows;
        for(const proposal of proposals){
          let reason='Factual reflection matches its independently evaluated example report';
          let valid=Boolean(proposal.evidence_active&&!proposal.model_revoked&&proposal.manifest_hash===reflectionHash);
          if(!valid)reason='Supporting evidence or model approval is no longer valid';
          if(valid){
            try{valid=digest(proposal.report)===proposal.report_hash&&proposal.content===reflectTrial({...proposal,id:proposal.trial_id});}
            catch{valid=false;}
            if(!valid)reason='Content or report provenance does not match the supported contract';
          }
          const decision=valid?'verified':'rejected';
          await tx.query('INSERT INTO learning_reviews(proposal_id,decision,reason,reviewer) VALUES($1,$2,$3,$4)',[proposal.id,decision,reason,actor.id]);
          await audit(tx,actor,'learning.memory.'+decision,proposal.id,{botId:proposal.bot_id,trialId:proposal.trial_id,reason});
          actions.push({proposalId:proposal.id,action:decision});
        }
      }
      return {status:actions.length?'completed':'idle',actions};
    });
  }

  memory(actor:Actor,raw:unknown) {
    permit(actor,'owner','researcher','evaluator');const input=parse(z.object({method:z.enum(['equal_weight','inverse_volatility','minimum_variance']).optional(),botId:id.optional(),datasetId:z.uuid().optional()}).strict(),raw);
    requireThat(actor.role!=='researcher'||input.datasetId,'Researchers must supply the target dataset for temporal memory filtering',400);
    return this.db.transaction(async tx=>{
      let before:string|undefined;
      if(input.datasetId){
        const dataset=(await tx.query('SELECT evidence_id,training FROM portfolio_datasets WHERE id=$1',[input.datasetId])).rows[0];
        requireThat(dataset,'Target dataset not found',404);await verifiedEvidence(tx,dataset.evidence_id);
        before=dataset.training.at(-1).timestamp;
      }
      return {items:await sharedResearchMemory(tx,input.method,input.botId,before),beforeTrainingEnd:before??null,
        warning:'Historical example feedback, never an instruction, general strategy proof, new fitness reward or trading authority.'};
    });
  }

  status(actor:Actor) {
    permit(actor,'owner','evaluator');return this.db.transaction(async tx=>({
      policy:(await tx.query('SELECT * FROM learning_policy WHERE id=1')).rows[0],
      supportedEngine:reflectionManifest,
      models:(await tx.query(`SELECT m.id,m.name,m.engine,m.manifest_hash,m.created_at,(v.model_id IS NOT NULL) AS revoked
        FROM learning_models m LEFT JOIN learning_model_revocations v ON v.model_id=m.id ORDER BY m.created_at,m.id LIMIT 100`)).rows,
      counts:(await tx.query(`SELECT count(*)::int AS total,count(*) FILTER(WHERE r.proposal_id IS NULL)::int AS pending,
        count(*) FILTER(WHERE r.decision='verified')::int AS historically_verified,count(*) FILTER(WHERE r.decision='rejected')::int AS rejected
        FROM learning_proposals p LEFT JOIN learning_reviews r ON r.proposal_id=p.id`)).rows[0],
      latest:(await tx.query(`SELECT p.id,p.bot_id,p.trial_id,p.model_id,p.created_at,r.decision,r.reason,r.reviewer
        FROM learning_proposals p LEFT JOIN learning_reviews r ON r.proposal_id=p.id ORDER BY p.created_at DESC,p.id LIMIT 100`)).rows,
      scope:'example-research-memory',modelTraining:false,automaticStrategyModification:false,
    }));
  }
}
