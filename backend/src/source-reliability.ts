import { Body, Controller, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { Actor, parse, permit } from './core.js';
import { Database, Sql } from './database.js';
import { Allow } from './security.js';

// Source reliability (KG-01, source dependence). Each source's record is built from what already happened to its
// output, never from what it says about itself: evidence verified / rejected / revoked by independent reviewers, claims
// accepted / rejected, and how long its items take to arrive after publication. The score is a smoothed share of good
// outcomes, with a revocation counting twice (it means a verified item later proved wrong or untrustworthy):
//   score = (verified + acceptedClaims + 1) / (decided + 2), decided = verified + 2*revoked + claims decided
// so a new source starts near 0.5 and only evidence moves it. Plain rejections are reported but NOT scored (KG-02, 28
// Oct 2026): the automatic fact-checker rejects an item for having no checkable claim (opinion, previews, "should you
// buy?") or no second source within its hold, which says nothing about whether the source got a fact wrong. Counting
// them gave all three approved feeds a score near 0.03 and a false "review its approval" alarm every day.
// The record informs reviewers and the owner's approval decisions; it never approves, revokes or weights anything.

const schema = z.object({ minDecided: z.number().int().min(0).max(1000).default(0) }).strict();
export const LOW_SCORE = 0.4, MIN_FOR_ALERT = 10;

export async function reliability(tx: Sql) {
  const rows = (await tx.query(`SELECT s.id,s.name,s.approved,
      COUNT(e.id) FILTER (WHERE e.status='verified')::int AS verified,
      COUNT(e.id) FILTER (WHERE e.status='rejected')::int AS rejected,
      COUNT(e.id) FILTER (WHERE e.status='revoked')::int AS revoked,
      COUNT(e.id) FILTER (WHERE e.status='unverified')::int AS pending,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (e.received_at - e.published_at))) AS lag_seconds
    FROM sources s LEFT JOIN evidence e ON e.source_id=s.id GROUP BY s.id ORDER BY s.id`)).rows;
  const claims = new Map((await tx.query(`SELECT e.source_id,
      COUNT(*) FILTER (WHERE r.decision='accepted')::int AS accepted, COUNT(*) FILTER (WHERE r.decision='rejected')::int AS rejected
    FROM evidence_claims c JOIN evidence e ON e.id=c.evidence_id JOIN evidence_claim_reviews r ON r.claim_id=c.id GROUP BY e.source_id`)).rows
    .map(r => [r.source_id as string, { accepted: Number(r.accepted), rejected: Number(r.rejected) }]));
  return rows.map(r => {
    const c = claims.get(r.id) ?? { accepted: 0, rejected: 0 };
    const good = r.verified + c.accepted;
    const decided = r.verified + 2 * r.revoked + c.accepted + c.rejected;
    return { sourceId: r.id as string, name: r.name as string, approved: r.approved as boolean,
      evidence: { verified: r.verified, rejected: r.rejected, revoked: r.revoked, pending: r.pending },
      claims: c, decided, score: Number(((good + 1) / (decided + 2)).toFixed(3)),
      medianArrivalMinutes: r.lag_seconds === null ? null : Math.max(0, Math.round(Number(r.lag_seconds) / 60)) };
  });
}

export class SourceReliability {
  constructor(private readonly db: Database) {}

  report(actor: Actor, raw: unknown) {
    permit(actor, 'owner', 'evaluator', 'researcher');
    const input = parse(schema, raw);
    return this.db.transaction(async tx => {
      const sources = (await reliability(tx)).filter(s => s.decided >= input.minDecided)
        .map(s => ({ ...s, flag: s.decided >= MIN_FOR_ALERT && s.score < LOW_SCORE ? 'low reliability: review this source\'s approval' : null }));
      return { sources: sources.sort((a, b) => a.score - b.score || a.sourceId.localeCompare(b.sourceId)),
        note: 'Built from independent reviews of each source\'s output. It informs approval decisions; it never changes them.' };
    }, false);
  }
}

type Request = { actor: Actor };
@Controller('v1')
export class SourceReliabilityController {
  constructor(private readonly sources: SourceReliability) {}
  @Post('sources/reliability') @Allow('owner', 'evaluator', 'researcher') report(@Req() r: Request, @Body() b: unknown) { return this.sources.report(r.actor, b); }
}
