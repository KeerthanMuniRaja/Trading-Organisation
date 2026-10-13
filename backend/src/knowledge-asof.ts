import { Body, Controller, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { Actor, id, parse, permit, requireThat, symbol, timestamp } from './core.js';
import { Database } from './database.js';
import { Allow } from './security.js';

// Point-in-time knowledge (KG-01): what the organisation knew, and had reviewed, at a cutoff. Evidence status is stored
// only as its current value, so the timeline is rebuilt from the append-only, hash-chained audit log
// (evidence.ingested / evidence.reviewed / evidence.authority.revoked, lesson.verified) plus the claims' own review
// times. An item revoked AFTER the cutoff still shows as usable at the cutoff (with the later change listed); one revoked
// BEFORE it does not. A decision can therefore be reconstructed exactly as it could have been made, without hindsight.

const schema = z.object({ asOf: timestamp, symbol: symbol.optional(), botId: id.optional(), limit: z.number().int().min(1).max(500).default(100) }).strict();
type Change = { at: string; status: string };

export class KnowledgeAsOf {
  constructor(private readonly db: Database) {}

  snapshot(actor: Actor, raw: unknown) {
    permit(actor, 'owner', 'evaluator', 'researcher');
    const input = parse(schema, raw);
    requireThat(Date.parse(input.asOf) <= Date.now() + 60_000, 'The cutoff cannot be in the future', 400);
    return this.db.transaction(async tx => {
      const cutoff = new Date(input.asOf).getTime();
      const events = (await tx.query(`SELECT action,entity,payload,created_at FROM audit_events
        WHERE action IN ('evidence.reviewed','evidence.authority.revoked','lesson.verified') ORDER BY sequence`)).rows;
      const evidenceChanges = new Map<string, Change[]>(), sourceRevoked = new Map<string, string>(), lessonVerified = new Map<string, string>();
      for (const e of events) {
        const at = new Date(e.created_at).toISOString();
        if (e.action === 'evidence.reviewed') evidenceChanges.set(e.entity, [...(evidenceChanges.get(e.entity) ?? []), { at, status: e.payload.status }]);
        else if (e.action === 'lesson.verified') { if (!lessonVerified.has(e.entity)) lessonVerified.set(e.entity, at); }
        else if (e.payload?.kind === 'source') { if (!sourceRevoked.has(e.entity)) sourceRevoked.set(e.entity, at); }
        else evidenceChanges.set(e.entity, [...(evidenceChanges.get(e.entity) ?? []), { at, status: 'revoked' }]);
      }
      const statusAt = (evidenceId: string, sourceId: string) => {
        const changes = evidenceChanges.get(evidenceId) ?? [];
        const before = changes.filter(c => Date.parse(c.at) <= cutoff);
        let status = before.length ? before[before.length - 1]!.status : 'unverified';
        const revokedSource = sourceRevoked.get(sourceId);
        if (revokedSource && Date.parse(revokedSource) <= cutoff) status = 'source-revoked';
        const later = changes.filter(c => Date.parse(c.at) > cutoff);
        if (revokedSource && Date.parse(revokedSource) > cutoff) later.push({ at: revokedSource, status: 'source-revoked' });
        return { status, later };
      };

      const filters: string[] = ['e.received_at <= $1', 'e.published_at <= $1'];
      const params: unknown[] = [input.asOf];
      if (input.symbol) { params.push(input.symbol); filters.push(`EXISTS (SELECT 1 FROM evidence_claims c WHERE c.evidence_id=e.id AND $${params.length}=ANY(c.symbols) AND c.created_at <= $1)`); }
      if (input.botId) { params.push(input.botId); filters.push(`e.id IN (SELECT l.evidence_id FROM lessons l WHERE l.bot_id=$${params.length} AND l.created_at <= $1)`); }
      params.push(input.limit);
      const evidence = (await tx.query(`SELECT e.id,e.source_id,e.kind,e.published_at,e.received_at,e.content FROM evidence e
        WHERE ${filters.join(' AND ')} ORDER BY e.published_at DESC,e.id LIMIT $${params.length}`, params)).rows;
      const ids = evidence.map(e => String(e.id));
      const claims = ids.length ? (await tx.query(`SELECT c.id,c.evidence_id,c.statement,c.symbols,c.event_type,c.created_at,r.decision,r.reviewed_at
        FROM evidence_claims c LEFT JOIN evidence_claim_reviews r ON r.claim_id=c.id WHERE c.evidence_id=ANY($1::uuid[]) AND c.created_at <= $2
        ORDER BY c.created_at`, [ids, input.asOf])).rows : [];
      const lessons = input.botId ? (await tx.query(`SELECT id,evidence_id,content,created_at FROM lessons WHERE bot_id=$1 AND created_at <= $2 ORDER BY created_at`,
        [input.botId, input.asOf])).rows : [];

      const items = evidence.map(e => {
        const { status, later } = statusAt(String(e.id), e.source_id);
        return { id: String(e.id), sourceId: e.source_id, kind: e.kind, publishedAt: new Date(e.published_at).toISOString(),
          receivedAt: new Date(e.received_at).toISOString(), excerpt: String(e.content).slice(0, 200), statusAtCutoff: status,
          usableAtCutoff: status === 'verified', changesAfterCutoff: later,
          claims: claims.filter(c => String(c.evidence_id) === String(e.id)).map(c => ({ id: String(c.id), statement: c.statement, symbols: c.symbols,
            eventType: c.event_type, decisionAtCutoff: c.reviewed_at && new Date(c.reviewed_at).getTime() <= cutoff ? c.decision : 'pending' })) };
      });
      const usable = new Set(items.filter(i => i.usableAtCutoff).map(i => i.id));
      const lessonViews = lessons.map(l => {
        const verifiedAt = lessonVerified.get(String(l.id));
        const verified = !!verifiedAt && Date.parse(verifiedAt) <= cutoff;
        return { id: String(l.id), evidenceId: String(l.evidence_id), excerpt: String(l.content).slice(0, 200), verifiedAtCutoff: verified,
          usableAtCutoff: verified && usable.has(String(l.evidence_id)) };
      });
      return { asOf: new Date(cutoff).toISOString(), filters: { symbol: input.symbol ?? null, botId: input.botId ?? null },
        summary: { evidence: items.length, usableEvidence: usable.size, acceptedClaims: items.flatMap(i => i.claims).filter(c => c.decisionAtCutoff === 'accepted').length,
          usableLessons: lessonViews.filter(l => l.usableAtCutoff).length, changedSince: items.filter(i => i.changesAfterCutoff.length).length },
        evidence: items, lessons: lessonViews,
        note: 'Rebuilt from the append-only audit log and claim reviews; later revocations are listed, not applied, so the view matches the cutoff.' };
    }, false);
  }
}

type Request = { actor: Actor };
@Controller('v1')
export class KnowledgeAsOfController {
  constructor(private readonly knowledge: KnowledgeAsOf) {}
  @Post('knowledge/as-of') @Allow('owner', 'evaluator', 'researcher') snapshot(@Req() r: Request, @Body() b: unknown) { return this.knowledge.snapshot(r.actor, b); }
}
