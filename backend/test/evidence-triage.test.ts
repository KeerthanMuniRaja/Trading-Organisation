import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, config, owner, researcher, evaluator, key } from './helpers.js';
import { EvidenceTriage, classify } from '../src/evidence-triage.js';
import { OwnerDigest } from '../src/owner-digest.js';
import { Database } from '../src/database.js';
import { createApp } from '../src/app.js';

test('fixed rules decide relevance: tracked shares by name, market-wide drivers, nothing else', () => {
  assert.deepEqual(classify('HDFC Bank and State Bank of India lead gains as the Nifty rises'), { decision: 'in-scope', matched: ['HDFCBANK', 'SBIN', 'market:Nifty'] });
  assert.deepEqual(classify('RBI keeps the repo rate unchanged'), { decision: 'in-scope', matched: ['market:RBI', 'market:repo rate'] });
  assert.equal(classify('Hollywood studio announces a sequel').decision, 'out-of-scope');
  assert.equal(classify('A bitter fight over litigation').decision, 'out-of-scope'); // 'itc' inside words, lower case: not ITC
  assert.equal(classify('Shares of ITC rose 2%').matched[0], 'ITC');
  assert.equal(classify('the sbi of the story').decision, 'out-of-scope'); // acronyms match only in capitals
  assert.equal(classify('Infosys\nwins a deal').matched[0], 'INFY');
});

test('scope-v2: news from abroad that reaches the shares through a world driver is in scope', () => {
  assert.deepEqual(classify('The Federal Reserve holds rates as Treasury yields climb'), { decision: 'in-scope', matched: ['world:Federal Reserve', 'world:Treasury yields'] });
  assert.deepEqual(classify('OPEC agrees a supply cut; Brent jumps'), { decision: 'in-scope', matched: ['world:OPEC', 'world:Brent'] });
  assert.deepEqual(classify('Infosys falls as the Nasdaq slides').matched, ['INFY', 'world:Nasdaq']);
  assert.equal(classify('the ecb of the story').decision, 'out-of-scope'); // acronyms in capitals only
  assert.equal(classify('A football club signs a new striker').decision, 'out-of-scope');
});

test('triage sets out-of-scope items aside from the queue, backlog and digest, without rejecting them, once', async () => {
  const f = await fixture(); try {
    await f.org.sources(owner, key(), { id: 'wire', name: 'Wire', url: 'https://wire.example.org/feed', approved: true });
    const add = async (content: string, kind = 'news') => (await f.org.evidence(researcher, key(), { sourceId: 'wire', kind, content,
      publishedAt: new Date(Date.now() - 3_600_000).toISOString() })).id as string;
    const relevant = await add('Axis Bank reports higher quarterly profit on loan growth.');
    const offTopic = await add('A celebrity wedding drew large crowds this weekend.');
    const dataset = await add('A table of numbers with no names at all.', 'dataset'); // only news and articles are triaged
    const triage = new EvidenceTriage(f.db);
    assert.throws(() => triage.run(researcher, key()));
    const result = await triage.run(evaluator, key());
    assert.deepEqual([result.triaged, result.inScope, result.outOfScope, result.byShare], [2, 1, 1, { AXISBANK: 1 }]);
    assert.equal((await triage.run(evaluator, key())).triaged, 0); // each item once

    const rows = (await f.db.transaction(tx => tx.query('SELECT e.id,e.status,t.decision FROM evidence e LEFT JOIN evidence_triage t ON t.evidence_id=e.id'))).rows;
    const by = Object.fromEntries(rows.map(r => [String(r.id), [r.status, r.decision]]));
    assert.deepEqual([by[relevant], by[offTopic], by[dataset]], [['unverified', 'in-scope'], ['unverified', 'out-of-scope'], ['unverified', null]]);
    const digest = await new OwnerDigest(f.db).digest(owner, {});
    assert.deepEqual([digest.knowledge.backlog, digest.knowledge.setAside], [2, 1]); // the relevant item and the dataset still wait
    await assert.rejects(() => f.db.transaction(tx => tx.query('DELETE FROM evidence_triage')));
    // a set-aside item can still be reviewed normally if someone chooses to
    await f.org.reviewEvidence(evaluator, key(), { evidenceId: offTopic, status: 'rejected' });
    // a backlog beyond one batch is drained in the same run, not left for tomorrow
    await f.db.transaction(async tx => {
      for (let i = 0; i < 1203; i++) await tx.query(`INSERT INTO evidence(id,source_id,kind,content,content_hash,published_at,status,author)
        VALUES($1,'wire','news',$2,$3,now(),'unverified','researcher')`, [crypto.randomUUID(), `Item ${i} about nothing tracked`, `bulk-${i}`]);
    });
    assert.equal((await triage.run(evaluator, key())).triaged, 1203);
    assert.equal((await f.ops.verifyAudit(owner)).valid, true);
  } finally { await f.db.close(); }
});

test('the triage route is evaluator and owner only', async () => {
  const { cfg } = config(), db = await Database.open(), app = await createApp(cfg, db, true);
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const post = (role: string) => fetch(base + '/v1/evidence/triage', { method: 'POST', body: '{}',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key(), Authorization: 'Bearer ' + cfg.principals.find(p => p.role === role)!.token } });
    assert.equal((await post('evaluator')).status, 201);
    assert.equal((await post('researcher')).status, 403);
  } finally { await app.close(); await db.close(); }
});
