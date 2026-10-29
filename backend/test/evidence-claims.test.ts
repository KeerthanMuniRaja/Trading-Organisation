import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, config, owner, researcher, evaluator, trader, key } from './helpers.js';
import { EvidenceClaims, figuresDisagree, normalise, numberInQuote } from '../src/evidence-claims.js';
import { Database } from '../src/database.js';
import { createApp } from '../src/app.js';

const ARTICLE = 'Reliance Industries on Friday reported a 12% rise in quarterly net profit, helped by retail. “We expect capital spending to stay elevated,” the company said.';

async function setup() {
  const f = await fixture();
  for (const id of ['publisher-a', 'publisher-b', 'publisher-c', 'publisher-d'])
    await f.org.sources(owner, key(), { id, name: id, url: `https://${id}.example.org/feed`, approved: true });
  const article = async (sourceId: string, content = ARTICLE, publishedAt = '2025-01-03T10:00:00Z') =>
    (await f.org.evidence(researcher, key(), { sourceId, kind: 'news', content, publishedAt })).id as string;
  const claim = (evidenceId: string, extra: Record<string, unknown> = {}) => ({ evidenceId, statement: 'Reliance quarterly profit rose 12%.',
    quote: 'reported a 12% rise in quarterly net profit', symbols: ['RELIANCE.NS'], eventType: 'earnings', direction: 'positive',
    eventDate: '2025-01-03', certainty: 'reported-fact', ...extra });
  return { ...f, claims: new EvidenceClaims(f.db), article, claim };
}

test('a claim needs a quote that is really in the evidence, a plausible date and a live source', async () => {
  const f = await setup(); try {
    const e = await f.article('publisher-a');
    const first = await f.claims.propose(researcher, key(), f.claim(e));
    assert.equal(first.status, 'pending');
    assert.equal((await f.claims.propose(researcher, key(), f.claim(e))).duplicate, true); // same quote, same evidence
    await assert.rejects(() => f.claims.propose(researcher, key(), f.claim(e, { quote: 'reported a 40% rise in quarterly net profit' })), /does not appear/);
    const curly = await f.claims.propose(researcher, key(), f.claim(e, { quote: '"We expect capital spending to stay elevated," the company said', certainty: 'company-statement' }));
    assert.equal(curly.status, 'pending'); // typographic quotes in the source still match
    await assert.rejects(() => f.claims.propose(researcher, key(), f.claim(e, { quote: 'helped by retail. “We expect capital spending', eventDate: '2025-02-01' })), /after its publication/);
    assert.throws(() => f.claims.propose(trader, key(), f.claim(e)));
    assert.throws(() => f.claims.propose(researcher, key(), { ...f.claim(e), approved: true }));
    await assert.rejects(() => f.claims.propose(researcher, key(), f.claim('00000000-0000-4000-8000-000000000000')), /not found/);
    await f.db.transaction(tx => tx.query('UPDATE system_lock SET halted=true WHERE id=1'));
    await assert.rejects(() => f.claims.propose(researcher, key(), f.claim(e, { quote: 'quarterly net profit, helped by retail' })), /halted/);
    await f.db.transaction(tx => tx.query('UPDATE system_lock SET halted=false WHERE id=1'));
    await f.org.revoke(owner, key(), { kind: 'source', targetId: 'publisher-a', reason: 'Withdrawn' });
    await assert.rejects(() => f.claims.propose(researcher, key(), f.claim(e, { symbols: ['RELIANCE.NS', 'NIFTY'] })), /not approved/);
    assert.equal(normalise('a—b  “c”'), 'a-b "c"');
  } finally { await f.db.close(); }
});

test('review is independent, acceptance needs verified evidence, and history cannot change', async () => {
  const f = await setup(); try {
    const e = await f.article('publisher-a');
    const c = await f.claims.propose(researcher, key(), f.claim(e));
    assert.throws(() => f.claims.review(researcher, key(), { claimId: c.id, decision: 'accepted', reason: 'Self' }));
    await assert.rejects(() => f.claims.review({ ...evaluator, id: researcher.id }, key(), { claimId: c.id, decision: 'accepted', reason: 'Own claim' }), /Independent/);
    await assert.rejects(() => f.claims.review(evaluator, key(), { claimId: c.id, decision: 'accepted', reason: 'Too early' }), /verified evidence/);
    await f.org.reviewEvidence(evaluator, key(), { evidenceId: e, status: 'verified' });
    const done = await f.claims.review(evaluator, key(), { claimId: c.id, decision: 'accepted', reason: 'Quote and figure checked.' });
    assert.equal(done.decision, 'accepted');
    await assert.rejects(() => f.claims.review(owner, key(), { claimId: c.id, decision: 'rejected', reason: 'Second opinion' }), /already reviewed/);
    await assert.rejects(() => f.db.transaction(tx => tx.query('DELETE FROM evidence_claim_reviews')));
    await assert.rejects(() => f.db.transaction(tx => tx.query("UPDATE evidence_claims SET statement='Profit tripled'")));
    const listed = await f.claims.list(owner, { evidenceId: e });
    assert.equal(listed.claims[0]!.usable, true);
    assert.equal(listed.claims[0]!.eventDate, '2025-01-03');
    assert.deepEqual(listed.claims[0]!.review, { decision: 'accepted', reviewer: 'evaluator', reason: 'Quote and figure checked.' });
    await f.org.revoke(owner, key(), { kind: 'evidence', targetId: e, reason: 'Correction published' });
    assert.equal((await f.claims.list(owner, { evidenceId: e })).claims[0]!.usable, false); // revocation removes usability
    assert.equal((await f.claims.list(owner, { status: 'pending' })).claims.length, 0);
    assert.equal((await f.ops.verifyAudit(owner)).valid, true);
  } finally { await f.db.close(); }
});

test('fact keys are complete and the reported figure must be written in the quote', async () => {
  const f = await setup(); try {
    const e = await f.article('publisher-a');
    const fact = { metric: 'Net Profit', period: 'Q3 FY25', reportedChangePct: 12 };
    const keyed = await f.claims.propose(researcher, key(), f.claim(e, fact));
    const [row] = (await f.claims.list(owner, { evidenceId: e })).claims;
    assert.equal(row!.id, keyed.id);
    assert.deepEqual([row!.metric, row!.period, row!.reportedChangePct], ['net profit', 'Q3FY25', 12]); // canonical keys
    await assert.rejects(() => f.claims.propose(researcher, key(), f.claim(e, { ...fact, reportedChangePct: 15,
      quote: 'helped by retail. “We expect capital spending' })), /must appear in the quote/);
    const issue = (pattern: RegExp) => (error: any) => pattern.test(JSON.stringify(error.getResponse()));
    assert.throws(() => f.claims.propose(researcher, key(), f.claim(e, { metric: 'net profit' })), issue(/both metric and period/));
    assert.throws(() => f.claims.propose(researcher, key(), f.claim(e, { reportedChangePct: 12 })), issue(/needs a fact key/));
    assert.equal(numberInQuote('profit rose 12.5% to Rs 1,250 crore', 12.5), true);
    assert.equal(numberInQuote('profit rose 112% this year', 12), false); // 12 is not a separate number here
    assert.equal(numberInQuote('revenue reached Rs 1,250 crore', 1250), true);
    assert.equal(numberInQuote('revenue fell 8 per cent', -8), true);
    assert.equal(figuresDisagree(12, 12.5), false);
    assert.equal(figuresDisagree(12, -3), true);
    assert.equal(figuresDisagree(40, 30), true);
  } finally { await f.db.close(); }
});

test('corroboration compares only the same figure for the same period; price opinions never decide it', async () => {
  const f = await setup(); try {
    const accept = async (sourceId: string, content: string, quote: string, extra: Record<string, unknown>, publishedAt: string) => {
      const e = await f.article(sourceId, content, publishedAt);
      await f.org.reviewEvidence(evaluator, key(), { evidenceId: e, status: 'verified' });
      const c = await f.claims.propose(researcher, key(), f.claim(e, { quote, eventDate: publishedAt.slice(0, 10), ...extra }));
      await f.claims.review(evaluator, key(), { claimId: c.id, decision: 'accepted', reason: 'Checked against the source text.' });
    };
    const q3 = { metric: 'net profit', period: 'Q3 FY25' };
    const wire = 'Reliance Industries reported a 12% rise in quarterly net profit';
    await accept('publisher-a', wire + ' on Friday.', wire, { ...q3, reportedChangePct: 12 }, '2025-01-03T10:00:00Z');
    await accept('publisher-b', wire + ', the wire said.', wire, { ...q3, reportedChangePct: 12 }, '2025-01-03T12:00:00Z'); // syndicated
    let result = await f.claims.corroboration(owner, { symbol: 'RELIANCE.NS' });
    assert.equal(result.clusters[0]!.status, 'single-source');
    assert.equal(result.clusters[0]!.independentOrigins, 1);
    // An independent report of the same figure, with an opposite price opinion: corroboration, not contradiction.
    await accept('publisher-c', 'RIL said net profit grew 12.4% year on year, though analysts expect the stock to lag.',
      'net profit grew 12.4% year on year', { ...q3, reportedChangePct: 12.4, direction: 'negative' }, '2025-01-04T09:00:00Z');
    result = await f.claims.corroboration(owner, { symbol: 'RELIANCE.NS' });
    assert.equal(result.clusters[0]!.status, 'corroborated');
    assert.deepEqual(result.clusters[0]!.priceOpinions, ['negative', 'positive']);
    // The event type is the drafting model's label, not the fact: the same figure filed under another type joins it.
    await accept('publisher-d', 'Exchange filing: Reliance quarterly net profit up 12% on retail.', 'Reliance quarterly net profit up 12%',
      { ...q3, reportedChangePct: 12, eventType: 'corporate-action' }, '2025-01-04T11:00:00Z');
    result = await f.claims.corroboration(owner, { symbol: 'RELIANCE.NS' });
    assert.deepEqual([result.clusters.length, result.clusters[0]!.independentOrigins, result.clusters[0]!.eventTypes], [1, 3, ['corporate-action', 'earnings']]);
    // A different period is a different fact, even in the same week.
    await accept('publisher-c', 'For the full year FY24, Reliance net profit fell 3% after weak refining margins.',
      'net profit fell 3% after weak refining margins', { metric: 'net profit', period: 'FY24', reportedChangePct: -3 }, '2025-01-05T09:00:00Z');
    // A claim with no fact key is reported as unmatched and can never corroborate.
    await accept('publisher-a', 'Reliance management sounded upbeat about retail growth on the analyst call.',
      'management sounded upbeat about retail growth', { direction: 'positive' }, '2025-01-05T10:00:00Z');
    result = await f.claims.corroboration(owner, { symbol: 'RELIANCE.NS', eventType: 'earnings' });
    assert.deepEqual(result.clusters.map(c => [c.period, c.status]), [['FY24', 'single-source'], ['Q3FY25', 'corroborated']]);
    assert.equal(result.unmatchedClaims, 1);
    // A source reporting a materially different figure for the same fact is a contradiction.
    await accept('publisher-b', 'A revised filing shows Reliance net profit actually fell 2% in the quarter.',
      'net profit actually fell 2% in the quarter', { ...q3, reportedChangePct: -2 }, '2025-01-06T09:00:00Z');
    result = await f.claims.corroboration(owner, { symbol: 'RELIANCE.NS', eventType: 'earnings' });
    const q3cluster = result.clusters.find(c => c.period === 'Q3FY25')!;
    assert.equal(q3cluster.status, 'contradicted');
    assert.deepEqual(q3cluster.reportedChangesPct, [12, 12, 12.4, -2]);
  } finally { await f.db.close(); }
});

test('routes are registered and guarded by role', async () => {
  const { cfg } = config(), db = await Database.open(), app = await createApp(cfg, db, true);
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const call = (path: string, role: string, body: unknown) => fetch(base + '/v1' + path, { method: 'POST', body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key(), Authorization: 'Bearer ' + cfg.principals.find(p => p.role === role)!.token } });
    assert.equal((await call('/evidence/claims/query', 'researcher', {})).status, 201);
    assert.equal((await call('/evidence/claims/query', 'trader', {})).status, 403);
    assert.equal((await call('/evidence/claims/reviews', 'researcher', { claimId: '00000000-0000-4000-8000-000000000000', decision: 'accepted', reason: 'x' })).status, 403);
    assert.equal((await call('/evidence/claims/corroboration', 'evaluator', { symbol: 'RELIANCE.NS' })).status, 201);
  } finally { await app.close(); await db.close(); }
});
