import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash, timingSafeEqual, verify } from 'node:crypto';
import { z } from 'zod';
import { Config } from './config.js';
import { Actor, Role, canonical, digest, parse, permit, requireThat, uuid } from './core.js';
import { Database, Sql, audit } from './database.js';

export const Allow = (...roles: Role[]) => SetMetadata('allowedRoles', roles);
export const Public = () => SetMetadata('publicRoute', true);
@Injectable()
export class ApiGuard implements CanActivate {
  private readonly keys;
  constructor(config: Config, private readonly reflector: Reflector) {
    this.keys = config.principals.map(({ token, ...actor }) => ({ actor, hash: createHash('sha256').update(token).digest() }));
  }
  canActivate(context: ExecutionContext): boolean {
    const handler = context.getHandler();
    if (this.reflector.get<boolean>('publicRoute', handler)) return true;
    const request = context.switchToHttp().getRequest();
    const header: unknown = request.headers.authorization;
    requireThat(typeof header === 'string' && /^Bearer [A-Za-z0-9_-]{43,200}$/.test(header), 'Authentication required', 401);
    const tokenHash = createHash('sha256').update(header.slice(7)).digest();
    const key = this.keys.find(k => timingSafeEqual(k.hash, tokenHash));
    requireThat(key, 'Authentication required', 401);
    const allowed = this.reflector.getAllAndOverride<Role[]>('allowedRoles', [handler, context.getClass()]) ?? [];
    permit(key.actor, ...allowed);
    request.actor = key.actor;
    return true;
  }
}
export const ownerAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('deposit'), payload: z.object({ amountPaise: z.string().regex(/^[1-9][0-9]{0,13}$/), bankReference: z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/) }).strict() }).strict(),
  z.object({ action: z.literal('transfer'), payload: z.object({ from: z.enum(['W1','W2']), to: z.enum(['W1','W2','SBI']), amountPaise: z.string().regex(/^[1-9][0-9]{0,13}$/) }).strict().refine(v => v.from !== v.to, 'Source and destination must differ') }).strict(),
  z.object({ action: z.literal('expense'), payload: z.object({ amountPaise: z.string().regex(/^[1-9][0-9]{0,13}$/), reference: z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/), category: z.enum(['compute','data','infrastructure','research']) }).strict() }).strict(),
]);
export const ownerRequest = z.object({ request: ownerAction, proof: z.object({ challengeId: z.uuid(), signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict() }).strict();
export class OwnerAuthorization {
  constructor(private readonly db: Database, private readonly config: Config) {}
  async challenge(actor: Actor, raw: unknown) {
    permit(actor, 'owner'); const input = parse(ownerAction, raw);
    return this.db.transaction(async tx => {
      await tx.query('DELETE FROM owner_challenges WHERE expires_at < now()');
      const outstanding = Number((await tx.query('SELECT count(*)::text AS count FROM owner_challenges WHERE consumed_at IS NULL')).rows[0]!.count);
      requireThat(outstanding < 20, 'Too many outstanding challenges', 429);
      const challengeId = uuid(), expiresAt = new Date(Date.now() + 120000).toISOString();
      const message = canonical({ purpose: 'trading-organisation-owner-approval-v1', mode: 'paper', actor: actor.id, challengeId, expiresAt, request: input });
      await tx.query('INSERT INTO owner_challenges (id,actor,action,payload_hash,message,expires_at) VALUES ($1,$2,$3,$4,$5,$6)', [challengeId,actor.id,input.action,digest(input),message,expiresAt]);
      await audit(tx, actor, 'owner.challenge.created', challengeId, { action: input.action, expiresAt });
      return { challengeId, expiresAt, message, request: input };
    });
  }
  async consume(tx: Sql, actor: Actor, input: z.infer<typeof ownerRequest>) {
    permit(actor, 'owner');
    const challenge = (await tx.query('SELECT * FROM owner_challenges WHERE id=$1 FOR UPDATE', [input.proof.challengeId])).rows[0];
    requireThat(challenge && challenge.actor === actor.id && !challenge.consumed_at && new Date(challenge.expires_at).getTime() > Date.now(), 'Approval expired, consumed, or unavailable', 403);
    requireThat(challenge.payload_hash === digest(input.request), 'Approval does not match transaction', 403);
    requireThat(verify(null, Buffer.from(challenge.message), this.config.ownerPublicKey, Buffer.from(input.proof.signature, 'base64url')), 'Invalid owner signature', 403);
    await tx.query('UPDATE owner_challenges SET consumed_at=now() WHERE id=$1', [challenge.id]);
    await audit(tx,actor,'owner.approval.consumed',challenge.id,{message:challenge.message,signature:input.proof.signature});
  }
}
