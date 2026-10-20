import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, config, owner, researcher, evaluator, key } from './helpers.js';
import { SourceReliability } from '../src/source-reliability.js';
import { OwnerAlerts } from '../src/alerts.js';
import { Database } from '../src/database.js';
import { createApp } from '../src/app.js';

test('each source earns a record from independent reviews of its output; poor sources are flagged and alerted', async () => {
  const f = await fixture(); try {
    for (const id of ['steady-wire', 'rumour-mill', 'newcomer'])
      await f.org.sources(owner, key(), { id, name: id, url: `https://${id}.example.org`, approved: true });
    const item = async (sourceId: string, status: 'verified' | 'rejected' | null) => {
      const e = await f.org.evidence(researcher, key(), { sourceId, kind: 'news', content: `${sourceId} report ${key()}`, publishedAt: new Date(Date.now() - 3_600_000).toISOString() });
      if (status) await f.org.reviewEvidence(evaluator, key(), { evidenceId: e.id, status });
      return e.id as string;
    };
    for (let i = 0; i < 12; i++) await item('steady-wire', 'verified');
    const later = [await item('rumour-mill', 'verified'), await item('rumour-mill', 'verified')];
    await item('rumour-mill', 'verified'); await item('rumour-mill', 'verified');
    for (let i = 0; i < 8; i++) await item('rumour-mill', 'rejected');
    for (const id of later) await f.org.revoke(evaluator, key(), { kind: 'evidence', targetId: id, reason: 'Retracted by the publisher' });
    await item('newcomer', null); // pending only: nothing decided yet

    const { sources } = await new SourceReliability(f.db).report(evaluator, {});
    const by = Object.fromEntries(sources.map(s => [s.sourceId, s]));
    assert.deepEqual(by['steady-wire']!.evidence, { verified: 12, rejected: 0, revoked: 0, pending: 0 });
    assert.equal(by['steady-wire']!.score, 0.929);            // (12 + 1) / (12 + 2)
    assert.equal(by['rumour-mill']!.decided, 14);              // 2 verified + 8 rejected + 2 revoked counted twice
    assert.equal(by['rumour-mill']!.score, 0.188);             // (2 + 1) / (14 + 2)
    assert.match(by['rumour-mill']!.flag!, /low reliability/);
    assert.equal(by['newcomer']!.score, 0.5);                  // no evidence either way yet
    assert.equal(by['newcomer']!.flag, null);
    assert.equal(sources[0]!.sourceId, 'rumour-mill');         // worst first
    assert.ok(by['steady-wire']!.medianArrivalMinutes! >= 59);

    const raised = (await new OwnerAlerts(f.db, f.cfg).cycle(evaluator, key())).raised;
    assert.deepEqual(raised.map(a => [a.rule, a.subject]), [['source-low-reliability', 'rumour-mill']]);
    await f.org.revoke(owner, key(), { kind: 'source', targetId: 'rumour-mill', reason: 'Unreliable' });
    assert.equal((await new OwnerAlerts(f.db, f.cfg).cycle(evaluator, key())).resolved, 1); // no longer approved: the alert resolves
  } finally { await f.db.close(); }
});

test('the reliability route is guarded by role', async () => {
  const { cfg } = config(), db = await Database.open(), app = await createApp(cfg, db, true);
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const post = (role: string) => fetch(base + '/v1/sources/reliability', { method: 'POST', body: '{}',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.principals.find(p => p.role === role)!.token } });
    assert.equal((await post('researcher')).status, 201);
    assert.equal((await post('trader')).status, 403);
  } finally { await app.close(); await db.close(); }
});
