import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, config, owner, researcher, evaluator, trader, key } from './helpers.js';
import { EvidenceClaims } from '../src/evidence-claims.js';
import { KnowledgeAsOf } from '../src/knowledge-asof.js';
import { Database } from '../src/database.js';
import { createApp } from '../src/app.js';

const ARTICLE = 'Reliance Industries on Friday reported a 12% rise in quarterly net profit, helped by retail growth across its stores.';
const tick = async () => { await new Promise(r => setTimeout(r, 25)); return new Date().toISOString(); };

test('the view at any cutoff shows exactly what was known and reviewed then, never later changes', async () => {
  const f = await fixture(); try {
    await f.org.sources(owner, key(), { id: 'wire', name: 'Wire', url: 'https://wire.example.org/feed', approved: true });
    await f.org.bot(owner, key(), { id: 'analyst', name: 'Analyst', department: 'desk', specialty: 'earnings', method: 'reasoning', contribution: 'As-of fixture', budgetPaise: '0' });
    const claims = new EvidenceClaims(f.db), asOf = new KnowledgeAsOf(f.db);
    const beforeAnything = await tick();
    const evidence = (await f.org.evidence(researcher, key(), { sourceId: 'wire', kind: 'news', content: ARTICLE, publishedAt: '2025-01-03T10:00:00Z' })).id as string;
    const ingested = await tick();
    await f.org.reviewEvidence(evaluator, key(), { evidenceId: evidence, status: 'verified' });
    const claim = await claims.propose(researcher, key(), { evidenceId: evidence, statement: 'Reliance quarterly profit rose 12%.',
      quote: 'reported a 12% rise in quarterly net profit', symbols: ['RELIANCE.NS'], eventType: 'earnings', direction: 'positive',
      eventDate: '2025-01-03', certainty: 'reported-fact' });
    await claims.review(evaluator, key(), { claimId: claim.id, decision: 'accepted', reason: 'Quote matches the article' });
    const lesson = await f.org.lesson(researcher, key(), { botId: 'analyst', content: 'Retail growth drove the profit rise.', evidenceId: evidence });
    await f.org.verifyLesson(evaluator, key(), { lessonId: lesson.id });
    const allGood = await tick();
    await f.org.revoke(evaluator, key(), { kind: 'evidence', targetId: evidence, reason: 'Publisher retracted the figure' });

    const empty = await asOf.snapshot(owner, { asOf: beforeAnything, symbol: 'RELIANCE.NS' });
    assert.equal(empty.summary.evidence, 0); // nothing had arrived yet

    const early = await asOf.snapshot(owner, { asOf: ingested, botId: 'analyst' });
    assert.deepEqual([early.evidence.length, early.evidence[0]?.statusAtCutoff], [0, undefined]); // no lesson cited it yet, so the bot filter finds nothing
    const raw = await asOf.snapshot(owner, { asOf: ingested });
    assert.deepEqual([raw.evidence[0]!.statusAtCutoff, raw.evidence[0]!.usableAtCutoff, raw.evidence[0]!.claims.length], ['unverified', false, 0]);

    const atCutoff = await asOf.snapshot(evaluator, { asOf: allGood, symbol: 'RELIANCE.NS', botId: 'analyst' });
    const item = atCutoff.evidence[0]!;
    assert.deepEqual([item.statusAtCutoff, item.usableAtCutoff, item.claims[0]!.decisionAtCutoff], ['verified', true, 'accepted']);
    assert.deepEqual(item.changesAfterCutoff.map(c => c.status), ['revoked']); // listed, not applied
    assert.deepEqual(atCutoff.lessons.map(l => [l.verifiedAtCutoff, l.usableAtCutoff]), [[true, true]]);
    assert.deepEqual([atCutoff.summary.usableEvidence, atCutoff.summary.acceptedClaims, atCutoff.summary.usableLessons, atCutoff.summary.changedSince], [1, 1, 1, 1]);

    const now = await asOf.snapshot(researcher, { asOf: new Date().toISOString(), symbol: 'RELIANCE.NS', botId: 'analyst' });
    assert.deepEqual([now.evidence[0]!.statusAtCutoff, now.evidence[0]!.usableAtCutoff, now.lessons[0]!.usableAtCutoff], ['revoked', false, false]);
    assert.throws(() => asOf.snapshot(trader, { asOf: allGood }));
    assert.throws(() => asOf.snapshot(owner, { asOf: '2099-01-01T00:00:00Z' }));
  } finally { await f.db.close(); }
});

test('a source revoked before the cutoff makes its evidence unusable at that cutoff', async () => {
  const f = await fixture(); try {
    await f.org.sources(owner, key(), { id: 'wire', name: 'Wire', url: 'https://wire.example.org/feed', approved: true });
    const evidence = (await f.org.evidence(researcher, key(), { sourceId: 'wire', kind: 'news', content: ARTICLE, publishedAt: '2025-01-03T10:00:00Z' })).id;
    await f.org.reviewEvidence(evaluator, key(), { evidenceId: evidence, status: 'verified' });
    const verified = await tick();
    await f.org.revoke(owner, key(), { kind: 'source', targetId: 'wire', reason: 'Terms withdrawn' });
    const after = await tick();
    const asOf = new KnowledgeAsOf(f.db);
    assert.equal((await asOf.snapshot(owner, { asOf: verified })).evidence[0]!.statusAtCutoff, 'verified');
    assert.deepEqual((await asOf.snapshot(owner, { asOf: verified })).evidence[0]!.changesAfterCutoff.map(c => c.status), ['source-revoked']);
    assert.equal((await asOf.snapshot(owner, { asOf: after })).evidence[0]!.statusAtCutoff, 'source-revoked');
  } finally { await f.db.close(); }
});

test('the as-of route is guarded by role', async () => {
  const { cfg } = config(), db = await Database.open(), app = await createApp(cfg, db, true);
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const post = (role: string) => fetch(base + '/v1/knowledge/as-of', { method: 'POST', body: JSON.stringify({ asOf: new Date().toISOString() }),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.principals.find(p => p.role === role)!.token } });
    assert.equal((await post('researcher')).status, 201);
    assert.equal((await post('trader')).status, 403);
  } finally { await app.close(); await db.close(); }
});
