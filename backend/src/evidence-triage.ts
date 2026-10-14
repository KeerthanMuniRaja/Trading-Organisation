import { Controller, Headers, Post, Req } from '@nestjs/common';
import { Actor, permit } from './core.js';
import { Database, audit } from './database.js';
import { Allow } from './security.js';

// Relevance triage (KNOW-02): fixed, versioned backend rules decide whether a waiting news item or article is about one
// of the tracked shares or a market-wide driver. Nobody chooses the result and no model is needed. Out-of-scope items
// stay unverified (they are not judged false); they leave the review queue, the backlog alert and the digest backlog,
// so reviewers and a future model spend their time on what can affect the portfolio. The term list is owner-editable
// code; changing it changes TRIAGE_VERSION, and earlier decisions keep the version that made them.

export const TRIAGE_VERSION = 'scope-v1';
/** Names a share is reported under. All-capital terms match case-sensitively (SBI, ITC), others ignore case. */
export const SHARE_TERMS: Record<string, string[]> = {
  RELIANCE: ['Reliance Industries', 'RIL', 'Reliance Jio', 'Jio Platforms', 'Reliance Retail', 'Mukesh Ambani'],
  HDFCBANK: ['HDFC Bank'], ICICIBANK: ['ICICI Bank'], INFY: ['Infosys'], SBIN: ['State Bank of India', 'SBI'],
  ITC: ['ITC'], AXISBANK: ['Axis Bank'], NTPC: ['NTPC'],
};
/** Drivers that move the whole basket. */
export const MARKET_TERMS = ['Sensex', 'Nifty', 'BSE', 'NSE', 'RBI', 'Reserve Bank', 'repo rate', 'monetary policy', 'inflation', 'CPI', 'GDP',
  'rupee', 'FII', 'FPI', 'foreign investors', 'Union Budget', 'SEBI', 'banking sector', 'bank stocks', 'IT sector', 'IT stocks', 'crude oil',
  'power sector', 'FMCG'];

const pattern = (term: string) => new RegExp(`(^|[^A-Za-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')}($|[^A-Za-z0-9])`,
  /^[A-Z]+$/.test(term) ? '' : 'i');
const SHARE_PATTERNS = Object.entries(SHARE_TERMS).map(([share, terms]) => [share, terms.map(pattern)] as const);
const MARKET_PATTERNS = MARKET_TERMS.map(t => [t, pattern(t)] as const);

/** What a text is about: the tracked shares it names, then market-wide drivers (at most 10 in all). */
export function classify(content: string) {
  const shares = SHARE_PATTERNS.filter(([, ps]) => ps.some(p => p.test(content))).map(([s]) => s);
  const market = MARKET_PATTERNS.filter(([, p]) => p.test(content)).map(([t]) => `market:${t}`);
  const matched = [...shares, ...market].slice(0, 10);
  return { decision: matched.length ? 'in-scope' as const : 'out-of-scope' as const, matched };
}

export class EvidenceTriage {
  constructor(private readonly db: Database) {}

  /** Classifies every waiting news item or article not yet triaged (up to 1000 per run). Evaluator or owner. */
  run(actor: Actor, key: string) {
    permit(actor, 'owner', 'evaluator');
    return this.db.command(actor, 'evidence-triage', key, { version: TRIAGE_VERSION }, async tx => {
      const waiting = (await tx.query(`SELECT e.id,e.content FROM evidence e WHERE e.status='unverified' AND e.kind IN ('news','article')
        AND NOT EXISTS (SELECT 1 FROM evidence_triage t WHERE t.evidence_id=e.id) ORDER BY e.received_at,e.id LIMIT 1000`)).rows;
      const byShare: Record<string, number> = {};
      let inScope = 0;
      for (const e of waiting) {
        const { decision, matched } = classify(String(e.content));
        await tx.query('INSERT INTO evidence_triage(evidence_id,decision,matched,rules_version,triaged_by) VALUES($1,$2,$3::text[],$4,$5)',
          [e.id, decision, matched, TRIAGE_VERSION, actor.id]);
        if (decision === 'in-scope') inScope++;
        for (const m of matched) if (!m.startsWith('market:')) byShare[m] = (byShare[m] ?? 0) + 1;
      }
      const result = { rulesVersion: TRIAGE_VERSION, triaged: waiting.length, inScope, outOfScope: waiting.length - inScope, byShare };
      await audit(tx, actor, 'evidence.triaged', TRIAGE_VERSION, result);
      return result;
    });
  }
}

type Request = { actor: Actor };
@Controller('v1')
export class EvidenceTriageController {
  constructor(private readonly triage: EvidenceTriage) {}
  @Post('evidence/triage') @Allow('owner', 'evaluator') run(@Req() r: Request, @Headers('idempotency-key') k: string) { return this.triage.run(r.actor, k ?? ''); }
}
