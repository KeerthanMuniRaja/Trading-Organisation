import { mkdir, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { Actor, canonical, digest, requireThat, uuid } from './core.js';

export type Row = Record<string, any>;
export interface Sql { query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>; }
export class Database {
  private constructor(private readonly local?: PGlite, private readonly pool?: Pool) {}
  static async open(path?: string, url?: string): Promise<Database> {
    if(!url && path && path!==':memory:') await mkdir(resolve(path),{recursive:true});
    const db = url ? new Database(undefined, new Pool({ connectionString: url, max: 8, connectionTimeoutMillis: 5000, statement_timeout: 10000 })) : new Database(new PGlite(path));
    try {
      const directory=resolve('db/migrations');
      for(const filename of (await readdir(directory)).filter(n=>/^\d+_.+\.sql$/.test(n)).sort()) {
        const version=Number(filename.split('_')[0]),migration=await readFile(resolve(directory,filename),'utf8');
        await db.transaction(async tx => {
          await tx.query('CREATE TABLE IF NOT EXISTS schema_versions (version integer PRIMARY KEY, checksum text NOT NULL)');
          const existing = (await tx.query('SELECT checksum FROM schema_versions WHERE version=$1',[version])).rows[0];
          const checksum = digest(migration);
          if (existing) requireThat(existing.checksum === checksum, 'Migration checksum mismatch');
          else {
            const embedded = tx as Sql & {exec?:(sql:string)=>Promise<unknown>};
            if(embedded.exec) await embedded.exec(migration); else await tx.query(migration);
            await tx.query('INSERT INTO schema_versions VALUES ($1,$2)', [version,checksum]);
          }
        }, false);
      }
    }catch(error){await db.close();throw error;}
    return db;
  }
  async transaction<T>(run: (sql: Sql) => Promise<T>, lock = true): Promise<T> {
    const execute = async (sql: Sql) => { if (lock) await sql.query('SELECT id FROM system_lock WHERE id=1 FOR UPDATE'); return run(sql); };
    if (this.local) return this.local.transaction(tx => execute(tx as Sql));
    const client = await this.pool!.connect();
    try {
      await client.query('BEGIN');
      const result = await execute(client);
      await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async command<T>(actor: Actor, namespace: string, key: string, input: unknown, run: (sql: Sql) => Promise<T>): Promise<T> {
    requireThat(/^[a-zA-Z0-9_-]{8,100}$/.test(key), 'A valid Idempotency-Key is required', 400);
    const fingerprint = digest(input);
    return this.transaction(async tx => {
      const old = (await tx.query('SELECT fingerprint, response FROM commands WHERE actor=$1 AND namespace=$2 AND key=$3', [actor.id, namespace, key])).rows[0];
      if (old) { requireThat(old.fingerprint === fingerprint, 'Idempotency key reused with different input'); return old.response as T; }
      const response = await run(tx);
      await tx.query('INSERT INTO commands VALUES ($1,$2,$3,$4,$5::jsonb)', [actor.id, namespace, key, fingerprint, JSON.stringify(response)]);
      return response;
    });
  }
  async close() { if (this.local) await this.local.close(); if (this.pool) await this.pool.end(); }
}
export async function audit(tx: Sql, actor: Actor, action: string, entity: string, payload: unknown) {
  const previous = (await tx.query('SELECT hash FROM audit_events ORDER BY sequence DESC LIMIT 1')).rows[0]?.hash ?? 'GENESIS';
  const event = { id: uuid(), actor: actor.id, action, entity, payload, previous };
  const hash = digest(event);
  await tx.query('INSERT INTO audit_events (id,actor,action,entity,payload,previous_hash,hash) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)', [event.id, actor.id, action, entity, canonical(payload), previous, hash]);
  await tx.query('INSERT INTO notifications (id,event_id,summary) VALUES ($1,$2,$3)', [uuid(), event.id, action + ': ' + entity]);
}
