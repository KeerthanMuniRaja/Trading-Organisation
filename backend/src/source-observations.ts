import { z } from 'zod';
import { Actor, digest, id, parse, permit, requireThat, text, timestamp, uuid } from './core.js';
import { Database, audit } from './database.js';

const inputSchema=z.object({sourceId:id,url:z.url().max(2048).refine(value=>{
  const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.hash;
}),title:z.string().trim().min(1).max(300),kind:z.enum(['news','article','filing']),content:text,publishedAt:timestamp}).strict();

export class SourceObservations {
  constructor(private readonly db:Database){}
  ingest(actor:Actor,key:string,raw:unknown){
    permit(actor,'researcher','market');const input=parse(inputSchema,raw);
    const snapshot={...input,url:new URL(input.url).href,publishedAt:new Date(input.publishedAt).toISOString()};
    return this.db.command(actor,'source-observation',key,snapshot,async tx=>{
      requireThat(!(await tx.query('SELECT halted FROM system_lock WHERE id=1')).rows[0]!.halted,'System halted');
      const source=(await tx.query('SELECT url FROM sources WHERE id=$1 AND approved=true',[snapshot.sourceId])).rows[0];
      requireThat(source,'Approved source required');
      requireThat(new URL(source.url).origin===new URL(snapshot.url).origin,'Article URL must match the approved source origin',400);
      requireThat(new Date(snapshot.publishedAt).getTime()<=Date.now(),'Publication time cannot be in the future',400);
      const hash=digest({kind:'source-observation-v1',snapshot});
      const old=(await tx.query(`SELECT o.evidence_id AS id,e.status,o.observed_at FROM source_observations o
        JOIN evidence e ON e.id=o.evidence_id WHERE o.snapshot_hash=$1`,[hash])).rows[0];
      if(old)return {...old,duplicate:true,provenance:'collector-submitted'};
      const count=(await tx.query("SELECT count(*)::int AS n FROM source_observations WHERE source_id=$1 AND observed_at>now()-interval '24 hours'",[snapshot.sourceId])).rows[0]!.n;
      requireThat(count<100,'Source observation capacity reached (100 per 24 hours)');
      const evidenceId=uuid();
      await tx.query(`INSERT INTO evidence(id,source_id,kind,content,content_hash,published_at,status,author)
        VALUES($1,$2,$3,$4,$5,$6,'unverified',$7)`,[evidenceId,snapshot.sourceId,snapshot.kind,snapshot.content,hash,snapshot.publishedAt,actor.id]);
      const row=(await tx.query(`INSERT INTO source_observations(evidence_id,source_id,url,title,snapshot_hash,provenance)
        VALUES($1,$2,$3,$4,$5,'collector-submitted') RETURNING observed_at`,[evidenceId,snapshot.sourceId,snapshot.url,snapshot.title,hash])).rows[0]!;
      await audit(tx,actor,'source.observation.ingested',evidenceId,{sourceId:snapshot.sourceId,snapshotHash:hash,provenance:'collector-submitted'});
      return {id:evidenceId,status:'unverified',observed_at:row.observed_at,duplicate:false,provenance:'collector-submitted'};
    });
  }
  list(actor:Actor,raw:unknown){
    permit(actor,'owner','researcher','evaluator');
    const input=parse(z.object({sourceId:id,status:z.enum(['unverified','verified','rejected','revoked']).optional()}).strict(),raw);
    return this.db.transaction(async tx=>{
      const rows=(await tx.query(`SELECT o.*,e.kind,e.content,e.published_at,e.status,e.author,e.reviewer,
        (e.status='verified' AND s.approved AND e.published_at<=now()) AS usable
        FROM source_observations o JOIN evidence e ON e.id=o.evidence_id JOIN sources s ON s.id=o.source_id
        WHERE o.source_id=$1 AND ($2::text IS NULL OR e.status=$2) ORDER BY o.observed_at DESC,o.evidence_id LIMIT 51`,[input.sourceId,input.status??null])).rows;
      return {observations:rows.slice(0,50),truncated:rows.length>50,scope:'collector-claims-not-verified-fetches'};
    });
  }
}
