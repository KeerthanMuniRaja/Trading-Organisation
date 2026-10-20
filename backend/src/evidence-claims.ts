import { Body, Controller, Headers, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { Actor, digest, parse, permit, requireThat, symbol, uuid } from './core.js';
import { Database, audit } from './database.js';
import { Allow } from './security.js';

// Evidence-backed claims: small checkable statements drawn from one evidence snapshot.
// The backend itself enforces what makes a claim trustworthy: its quote must appear in the stored evidence
// text, a reviewer must be independent of both the claim author and the evidence author, acceptance needs
// verified evidence from an approved source, and history is append-only. Corroboration counts independent
// sources, merging near-identical (syndicated) quotes into one origin; it measures agreement, not truth.
// Claims are only compared through a fact key (metric + period, e.g. "net profit" + "Q2FY27"): two reports
// corroborate only when they concern the same figure for the same period, and contradict only when the
// reported figures disagree. Price-direction opinions are reported but never decide either.

const EVENT_TYPES = ['earnings', 'guidance', 'order-or-contract', 'regulatory-or-legal', 'management', 'corporate-action',
  'deal-or-investment', 'rating-or-target', 'macro-or-sector', 'other'] as const;
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => !Number.isNaN(Date.parse(v + 'T00:00:00Z')), 'Invalid date');
const proposalSchema = z.object({
  evidenceId: z.uuid(), statement: z.string().trim().min(1).max(240), quote: z.string().trim().min(20).max(300),
  symbols: z.array(symbol).min(1).max(3), eventType: z.enum(EVENT_TYPES),
  direction: z.enum(['positive', 'negative', 'neutral', 'unclear']), eventDate: day.nullable(),
  certainty: z.enum(['reported-fact', 'company-statement', 'forecast', 'opinion', 'rumour']),
  metric: z.string().trim().min(1).max(60).regex(/^[A-Za-z0-9 %&()/.,'-]+$/).optional(),
  period: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9 _/.-]+$/).optional(),
  reportedChangePct: z.number().finite().min(-1000).max(1000).optional(),
}).strict()
  .refine(v => (v.metric === undefined) === (v.period === undefined), 'A fact key needs both metric and period')
  .refine(v => v.reportedChangePct === undefined || v.metric !== undefined, 'A reported change needs a fact key');
/** Canonical fact-key parts: "Net  Profit" and "net profit" match; "Q2 FY27" and "q2fy27" match. */
export const metricKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9%&]+/g, ' ').trim();
export const periodKey = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]+/g, '');
/** The reported figure must be written in the quote itself (as digits), so a claim cannot invent its number. */
export function numberInQuote(quote: string, value: number) {
  const text = Number(Math.abs(value).toFixed(2)).toString();
  const [whole, fraction] = text.split('.');
  const pattern = fraction ? `${whole}\\.${fraction}0*` : `${whole}(?:\\.0+)?`;
  return new RegExp(`(?<![0-9.])${pattern}(?![0-9])`).test(quote.replace(/,(?=\d{3})/g, ''));
}
const reviewSchema = z.object({ claimId: z.uuid(), decision: z.enum(['accepted', 'rejected']), reason: z.string().trim().min(1).max(300) }).strict();
const listSchema = z.object({ evidenceId: z.uuid().optional(), symbol: symbol.optional(),
  status: z.enum(['pending', 'accepted', 'rejected']).optional(), limit: z.number().int().min(1).max(100).default(50) }).strict();
const corroborationSchema = z.object({ symbol, eventType: z.enum(EVENT_TYPES).optional() }).strict();
const SYNDICATED = 0.8;

/** Comparable text: Unicode-normalised, typographic quotes and dashes made plain, whitespace collapsed. */
export function normalise(value: string): string {
  return value.normalize('NFKC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ').trim();
}
function tokens(value: string) { return new Set(value.toLowerCase().match(/[a-z0-9]+/g) ?? []); }
function overlap(a: string, b: string) {
  const ta = tokens(a), tb = tokens(b), union = new Set([...ta, ...tb]);
  return union.size ? [...ta].filter(t => tb.has(t)).length / union.size : 0;
}
type Row = Record<string, any>;
function view(row: Row) {
  return { id: String(row.id), evidenceId: String(row.evidence_id), statement: row.statement, quote: row.quote, symbols: row.symbols,
    eventType: row.event_type, direction: row.direction, eventDate: row.event_day ?? null,
    metric: row.metric ?? null, period: row.period ?? null,
    reportedChangePct: row.reported_change_pct === null || row.reported_change_pct === undefined ? null : Number(row.reported_change_pct),
    certainty: row.certainty, author: row.author, sourceId: row.source_id, publishedAt: new Date(row.published_at).toISOString(),
    evidenceStatus: row.evidence_status, review: row.decision ? { decision: row.decision, reviewer: row.reviewer, reason: row.reason } : null,
    usable: row.decision === 'accepted' && row.evidence_status === 'verified' && row.source_approved === true };
}
const SELECT = `SELECT c.*,to_char(c.event_date,'YYYY-MM-DD') AS event_day,e.source_id,e.published_at,e.status AS evidence_status,s.approved AS source_approved,r.decision,r.reviewer,r.reason
  FROM evidence_claims c JOIN evidence e ON e.id=c.evidence_id JOIN sources s ON s.id=e.source_id
  LEFT JOIN evidence_claim_reviews r ON r.claim_id=c.id`;

export class EvidenceClaims {
  constructor(private readonly db: Database) {}

  propose(actor: Actor, key: string, raw: unknown) {
    permit(actor, 'researcher');
    const input = parse(proposalSchema, raw);
    const symbols = [...new Set(input.symbols)].sort();
    const quote = normalise(input.quote);
    return this.db.command(actor, 'evidence-claim', key, input, async tx => {
      requireThat(!(await tx.query('SELECT halted FROM system_lock WHERE id=1')).rows[0]!.halted, 'System halted');
      const e = (await tx.query(`SELECT e.content,e.status,to_char(e.published_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS published_day,s.approved
        FROM evidence e JOIN sources s ON s.id=e.source_id WHERE e.id=$1`, [input.evidenceId])).rows[0];
      requireThat(e, 'Evidence not found', 404);
      requireThat(e.approved === true, 'Evidence source is not approved');
      requireThat(e.status === 'unverified' || e.status === 'verified', 'Claims cannot be drawn from rejected or revoked evidence');
      requireThat(normalise(String(e.content)).includes(quote), 'Quote does not appear in the evidence text', 400);
      const published = String(e.published_day);
      requireThat(!(input.certainty === 'reported-fact' && input.eventDate && input.eventDate > published),
        'A reported fact cannot be dated after its publication', 400);
      requireThat(input.reportedChangePct === undefined || numberInQuote(quote, input.reportedChangePct),
        'The reported figure must appear in the quote', 400);
      const hash = digest({ evidenceId: input.evidenceId, quote, symbols });
      const old = (await tx.query('SELECT id FROM evidence_claims WHERE content_hash=$1', [hash])).rows[0];
      if (old) return { id: String(old.id), status: 'pending', duplicate: true };
      const id = uuid();
      const metric = input.metric === undefined ? null : metricKey(input.metric);
      const period = input.period === undefined ? null : periodKey(input.period);
      requireThat((metric === null || metric.length > 0) && (period === null || period.length > 0), 'Fact key is empty after normalising', 400);
      await tx.query(`INSERT INTO evidence_claims(id,evidence_id,statement,quote,symbols,event_type,direction,event_date,certainty,author,content_hash,
        metric,period,reported_change_pct) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [id, input.evidenceId, input.statement, quote, symbols, input.eventType, input.direction, input.eventDate, input.certainty, actor.id, hash,
          metric, period, input.reportedChangePct ?? null]);
      await audit(tx, actor, 'evidence.claim.proposed', id, { evidenceId: input.evidenceId, symbols, eventType: input.eventType, metric, period });
      return { id, status: 'pending', duplicate: false };
    });
  }

  review(actor: Actor, key: string, raw: unknown) {
    permit(actor, 'owner', 'evaluator');
    const input = parse(reviewSchema, raw);
    return this.db.command(actor, 'evidence-claim-review', key, input, async tx => {
      const c = (await tx.query(`SELECT c.author,e.author AS evidence_author,e.status,s.approved FROM evidence_claims c
        JOIN evidence e ON e.id=c.evidence_id JOIN sources s ON s.id=e.source_id WHERE c.id=$1`, [input.claimId])).rows[0];
      requireThat(c, 'Claim not found', 404);
      requireThat(c.author !== actor.id && c.evidence_author !== actor.id, 'Independent claim review required', 403);
      requireThat(!(await tx.query('SELECT 1 FROM evidence_claim_reviews WHERE claim_id=$1', [input.claimId])).rows.length,
        'Claim already reviewed; propose a corrected claim instead');
      if (input.decision === 'accepted')
        requireThat(c.status === 'verified' && c.approved === true, 'Accepting a claim requires verified evidence from an approved source');
      await tx.query('INSERT INTO evidence_claim_reviews(claim_id,decision,reviewer,reason) VALUES($1,$2,$3,$4)',
        [input.claimId, input.decision, actor.id, input.reason]);
      await audit(tx, actor, 'evidence.claim.reviewed', input.claimId, { decision: input.decision });
      return { id: input.claimId, decision: input.decision };
    });
  }

  list(actor: Actor, raw: unknown) {
    permit(actor, 'owner', 'researcher', 'evaluator');
    const input = parse(listSchema, raw);
    return this.db.transaction(async tx => {
      const rows = (await tx.query(`${SELECT} WHERE ($1::uuid IS NULL OR c.evidence_id=$1) AND ($2::text IS NULL OR $2=ANY(c.symbols))
        AND ($3::text IS NULL OR ($3='pending' AND r.decision IS NULL) OR r.decision=$3) ORDER BY c.created_at,c.id LIMIT $4`,
        [input.evidenceId ?? null, input.symbol ?? null, input.status ?? null, input.limit])).rows;
      return { claims: rows.map(view), warning: 'Claims quote untrusted sources; acceptance means checked and reviewed, not proven true.' };
    }, false);
  }

  corroboration(actor: Actor, raw: unknown) {
    permit(actor, 'owner', 'researcher', 'evaluator');
    const input = parse(corroborationSchema, raw);
    return this.db.transaction(async tx => {
      const rows = (await tx.query(`${SELECT} WHERE $1=ANY(c.symbols) AND ($2::text IS NULL OR c.event_type=$2)
        ORDER BY e.published_at,c.id LIMIT 500`, [input.symbol, input.eventType ?? null])).rows.map(view).filter(c => c.usable);
      const keyed = rows.filter(c => c.metric && c.period);
      return { symbol: input.symbol, clusters: cluster(keyed), unmatchedClaims: rows.length - keyed.length,
        note: 'Only accepted claims on verified evidence with a fact key (metric and period) are compared. Corroboration measures '
          + 'independent agreement about the same figure, not truth; claims without a fact key cannot corroborate anything.' };
    }, false);
  }
}

type Claim = ReturnType<typeof view>;
type Cluster = { eventType: string; metric: string; period: string; status: 'contradicted' | 'corroborated' | 'single-source';
  independentOrigins: number; reportedChangesPct: number[]; priceOpinions: string[]; claimIds: string[];
  firstPublishedAt: string; lastPublishedAt: string };
/** Two reported figures disagree when their signs differ or they differ by more than 1 point or 10%, whichever is larger. */
export function figuresDisagree(a: number, b: number) {
  return (a > 0 && b < 0) || (a < 0 && b > 0) || Math.abs(a - b) > Math.max(1, 0.1 * Math.max(Math.abs(a), Math.abs(b)));
}
/** One cluster per fact (event type, metric, period). Claims without a fact key must be filtered out by the caller. */
export function cluster(claims: Claim[]): Cluster[] {
  const byFact = new Map<string, Claim[]>();
  for (const c of claims) {
    const key = JSON.stringify([c.eventType, c.metric, c.period]);
    byFact.set(key, [...(byFact.get(key) ?? []), c]);
  }
  const out: Cluster[] = [];
  for (const [key, items] of [...byFact.entries()].sort()) {
    const [eventType, metric, period] = JSON.parse(key) as [string, string, string];
    items.sort((a, b) => a.publishedAt.localeCompare(b.publishedAt) || a.id.localeCompare(b.id));
    const origins: { sources: Set<string>; quotes: string[] }[] = [];
    for (const c of items) {
      const match = origins.find(o => o.sources.has(c.sourceId) || o.quotes.some(q => overlap(q, c.quote) >= SYNDICATED));
      if (match) { match.sources.add(c.sourceId); match.quotes.push(c.quote); } else origins.push({ sources: new Set([c.sourceId]), quotes: [c.quote] });
    }
    const figures = items.map(c => c.reportedChangePct).filter((v): v is number => v !== null);
    const contradicted = figures.some((a, x) => figures.slice(x + 1).some(b => figuresDisagree(a, b)));
    out.push({ eventType, metric, period, status: contradicted ? 'contradicted' : origins.length >= 2 ? 'corroborated' : 'single-source',
      independentOrigins: origins.length, reportedChangesPct: figures, priceOpinions: [...new Set(items.map(c => c.direction))].sort(),
      claimIds: items.map(c => c.id), firstPublishedAt: items[0]!.publishedAt, lastPublishedAt: items.at(-1)!.publishedAt });
  }
  return out;
}

type Request = { actor: Actor };
@Controller('v1')
export class EvidenceClaimsController {
  constructor(private readonly claims: EvidenceClaims) {}
  @Post('evidence/claims') @Allow('researcher') propose(@Req() r: Request, @Headers('idempotency-key') k: string, @Body() b: unknown) { return this.claims.propose(r.actor, k ?? '', b); }
  @Post('evidence/claims/reviews') @Allow('owner', 'evaluator') review(@Req() r: Request, @Headers('idempotency-key') k: string, @Body() b: unknown) { return this.claims.review(r.actor, k ?? '', b); }
  @Post('evidence/claims/query') @Allow('owner', 'researcher', 'evaluator') list(@Req() r: Request, @Body() b: unknown) { return this.claims.list(r.actor, b); }
  @Post('evidence/claims/corroboration') @Allow('owner', 'researcher', 'evaluator') corroboration(@Req() r: Request, @Body() b: unknown) { return this.claims.corroboration(r.actor, b); }
}
