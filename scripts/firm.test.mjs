import assert from 'node:assert/strict';
import test from 'node:test';
import { plan, propose, recordText, SOURCE } from './firm.mjs';

const ENV = { API_URL: 'http://127.0.0.1:3000', PRINCIPALS_JSON: JSON.stringify([{ role: 'researcher', token: 'r' }, { role: 'evaluator', token: 'e' },
  { role: 'owner', token: 'o' }, { role: 'trader', token: 't', botId: 'momentum-rules' }]) };
const BOTS = [{ id: 'momentum-rules', department: 'desk', specialty: 'momentum-allocation', method: 'top3-momentum-6m', state: 'paper' },
  { id: 'tradingagents', department: 'desk', specialty: 'multi-agent-research', method: 'tradingagents', state: 'school' },
  { id: 'trend-bot', department: 'research', specialty: 'daily-trend', method: 'trend', state: 'paper' },
  { id: 'old-bot', department: 'research', specialty: 'x', method: 'y', state: 'retired' },
  { id: 'scout', department: 'scouting', specialty: 'z', method: 'z', state: 'school' }];
const CHARTERS = { desk: { name: 'Trading desk', mandate: 'Runs the paper-trading members.' }, research: { name: 'Research', mandate: 'Finds and tests ideas.' } };

/** A backend that enforces what the real routes do: who may call, and content-bound verification. */
function backend({ evaluatorSees = BOTS, pending = [] } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = url.replace('http://127.0.0.1:3000', ''), role = { r: 'researcher', e: 'evaluator', o: 'owner' }[init.headers.Authorization.split(' ')[1]];
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, role, body, key: init.headers['Idempotency-Key'] });
    const reply = path === '/v1/departments' ? { departments: [], unregisteredLabels: ['desk', 'research', 'scouting'], pendingProposals: pending }
      : path === '/v1/bots' ? (role === 'evaluator' ? evaluatorSees : BOTS)
        : path === '/v1/evidence' ? { id: `ev-${calls.length}`, status: 'unverified' }
          : path === '/v1/evidence/reviews' ? { status: body.status }
            : path === '/v1/departments/proposals' ? { id: `prop-${body.departmentId}` } : {};
    return { ok: true, status: 201, text: async () => JSON.stringify(reply) };
  };
  return { calls, fetchImpl };
}

test('each existing bot group is proposed as a department on verified evidence of its own record', async () => {
  const b = backend();
  const out = await propose(ENV, { fetchImpl: b.fetchImpl, charters: CHARTERS, now: new Date('2026-10-29T08:00:00Z') });
  assert.deepEqual(out.map(o => [o.departmentId, o.state]), [['desk', 'proposed'], ['research', 'proposed'], ['scouting', 'no charter']]);
  const evidence = b.calls.filter(c => c.path === '/v1/evidence');
  assert.deepEqual([evidence[0].role, evidence[0].body.sourceId, evidence[0].body.kind], ['researcher', SOURCE.id, 'dataset']);
  assert.match(evidence[0].body.content, /'desk' has 2 active member\(s\): momentum-rules \(momentum-allocation, top3-momentum-6m, paper\); tradingagents/);
  const reviews = b.calls.filter(c => c.path === '/v1/evidence/reviews');
  assert.deepEqual(reviews.map(r => [r.role, r.body.status]), [['evaluator', 'verified'], ['evaluator', 'verified']]);  // a different identity
  const proposals = b.calls.filter(c => c.path === '/v1/departments/proposals');
  assert.deepEqual(proposals.map(p => [p.role, p.body.kind, p.body.departmentId, p.body.name]), [['researcher', 'open', 'desk', 'Trading desk'], ['researcher', 'open', 'research', 'Research']]);
  assert.ok(proposals.every(p => p.body.evidenceIds.length === 1 && p.body.rationale.length <= 1000));
  assert.ok(!b.calls.some(c => c.role === 'owner'));  // the agents propose; only the owner decides, elsewhere
});

test('a record the evaluator cannot reproduce is rejected, and nothing is proposed on it', async () => {
  const b = backend({ evaluatorSees: BOTS.map(x => x.id === 'tradingagents' ? { ...x, state: 'paper' } : x) });
  const out = await propose(ENV, { fetchImpl: b.fetchImpl, charters: { desk: CHARTERS.desk }, now: new Date('2026-10-29T08:00:00Z') });
  assert.equal(out[0].state, 'evidence rejected: the evaluator read a different record');
  assert.equal(b.calls.find(c => c.path === '/v1/evidence/reviews').body.status, 'rejected');
  assert.ok(!b.calls.some(c => c.path === '/v1/departments/proposals'));
  const again = backend({ pending: [{ departmentId: 'desk' }] });
  assert.equal((await propose(ENV, { fetchImpl: again.fetchImpl, charters: { desk: CHARTERS.desk } }))[0].state, 'already proposed');
});

test('the plan recommends ceilings equal to what the members already hold, and leaves retired bots out', () => {
  const p = plan({ unregisteredLabels: ['desk', 'research', 'scouting'] }, BOTS, CHARTERS, { 'momentum-rules': '500000', tradingagents: '500000', 'trend-bot': '100000', 'old-bot': '999999' });
  assert.deepEqual(p.map(x => [x.departmentId, x.recommendedCeilingPaise, x.members.length]), [['desk', '1000000', 2], ['research', '100000', 1], ['scouting', '0', 1]]);
  assert.match(p[2].problem, /no charter for 'scouting'/);
  assert.equal(recordText('research', BOTS, '2026-10-29'), "Organisation records, 2026-10-29: the bot group 'research' has 1 active member(s): trend-bot (daily-trend, trend, paper)."
    + ' They already work under this label in the daily cycle; a registered department gives them a charter, a lead and a budget ceiling.');
});
