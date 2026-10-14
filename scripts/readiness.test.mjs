import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UNIVERSE, assess, expectedSession, run, verdict } from './readiness.mjs';

const WED_MORNING = Date.parse('2026-10-14T03:00:00Z'); // 08:30 IST Wednesday, before the open
const prices = (date, closePaise = '50000') => Object.fromEntries(UNIVERSE.map(s => [s, { date, closePaise }]));
const ready = {
  health: true, audit: { valid: true }, digest: { halted: false, alerts: {} }, prices: prices('2026-10-13'), credentials: { missing: [] },
  limits: { maxOrderPaise: '500000', feeBps: 10, slippageBps: 5 }, lastCycle: { day: '2026-10-13', failed: [] }, backupAt: WED_MORNING - 3_600_000,
  ruleBot: { id: 'momentum-rules', credential: true, state: 'paper', activeModel: 'rules:top3-momentum-6m' },
};
const status = (checks, id) => checks.find(c => c.id === id)?.status;

test('the expected session is the last weekday whose close has settled', () => {
  assert.equal(expectedSession(WED_MORNING), '2026-10-13');                        // before today's close: yesterday
  assert.equal(expectedSession(Date.parse('2026-10-14T11:00:00Z')), '2026-10-14'); // after 16:00 IST: today
  assert.equal(expectedSession(Date.parse('2026-10-19T03:00:00Z')), '2026-10-16'); // Monday morning: Friday
});

test('a fully prepared organisation is GO', () => {
  const checks = assess(ready, WED_MORNING);
  assert.equal(verdict(checks), 'GO', JSON.stringify(checks.filter(c => c.status !== 'GO')));
});

test('each blocker is named with what to do', () => {
  assert.deepEqual(assess({ ...ready, health: false }, WED_MORNING).map(c => [c.id, c.status]), [['backend', 'NO-GO']]);
  assert.equal(status(assess({ ...ready, audit: { valid: false } }, WED_MORNING), 'audit-chain'), 'NO-GO');
  assert.equal(status(assess({ ...ready, digest: { halted: true, alerts: {} } }, WED_MORNING), 'risk-halt'), 'NO-GO');
  assert.equal(status(assess({ ...ready, digest: null }, WED_MORNING), 'risk-halt'), 'NO-GO'); // unknown is never GO
  assert.equal(status(assess({ ...ready, digest: { halted: false, alerts: { critical: 1 } } }, WED_MORNING), 'alerts'), 'NO-GO');
  assert.equal(status(assess({ ...ready, prices: prices('2026-10-05') }, WED_MORNING), 'market-data'), 'NO-GO');
  assert.equal(status(assess({ ...ready, prices: prices('2026-10-12') }, WED_MORNING), 'market-data'), 'WARN'); // maybe a holiday
  const rb = s => status(assess({ ...ready, ruleBot: { ...ready.ruleBot, ...s } }, WED_MORNING), 'rule-bot');
  assert.deepEqual([rb({ id: null }), rb({ credential: false }), rb({ state: 'school' }), rb({ activeModel: null })], ['WARN', 'NO-GO', 'NO-GO', 'NO-GO']);
  const dear = assess({ ...ready, limits: { ...ready.limits, maxOrderPaise: '100000' }, prices: { ...prices('2026-10-13'), ICICIBANK: { date: '2026-10-13', closePaise: '136020' } } }, WED_MORNING);
  assert.match(dear.find(c => c.id === 'order-limit').detail, /below one share of ICICIBANK; those proposals will be rejected/);
  assert.equal(verdict(dear), 'GO WITH WARNINGS');
  assert.ok(assess({ ...ready, credentials: { missing: ['owner'] } }, WED_MORNING).every(c => c.status === 'GO' || c.action));
  const split = assess({ ...ready, lastCycle: { day: '2026-10-13', failed: [], degraded: [{ id: 'market-data',
    note: 'possible split or bonus, record it in /v1/corporate-actions: HDFCBANK x2 from 2026-10-13' }] } }, WED_MORNING).find(c => c.id === 'needs-owner');
  assert.deepEqual([split.status, split.action], ['WARN', 'Check the exchange notice, then record it: POST /v1/corporate-actions']);
  const learning = assess({ ...ready, lastCycle: { day: '2026-10-13', failed: [], degraded: [], skipped: [{ id: 'claims-and-fact-check', reason: 'model steps not enabled (--with-model)' },
    { id: 'rule-bot', reason: 'not configured' }] } }, WED_MORNING).find(c => c.id === 'learning');
  assert.match(learning.detail, /no knowledge was learned in the last cycle: claims-and-fact-check skipped \(model steps not enabled/);
  assert.doesNotMatch(learning.detail, /rule-bot/); // only learning steps count here
});

test('a run reads the backend and local files, writes the report, and never sends a change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ready-'));
  try {
    await mkdir(join(root, '.local', 'trading-desk', 'daily'), { recursive: true });
    for (const s of UNIVERSE) await writeFile(join(root, '.local', 'trading-desk', 'daily', `${s}.NS-1d.json`),
      JSON.stringify({ symbol: s + '.NS', bars: [{ date: '2026-10-13', closePaise: 50000 }] }));
    await mkdir(join(root, '.local', 'cycles'), { recursive: true });
    await writeFile(join(root, '.local', 'cycles', '2026-10-13.json'), JSON.stringify({ steps: { 'market-data': { status: 'done' }, 'news-x': { status: 'failed' } } }));
    const calls = [];
    const answers = { '/v1/health': { mode: 'paper' }, '/v1/audit/integrity': { valid: true }, '/v1/owner/digest': { halted: false, alerts: {} },
      '/v1/bots': [{ id: 'momentum-rules', state: 'paper' }], '/v1/releases/view': { active: 'r1', releases: [{ id: 'r1', model: 'rules:top3-momentum-6m' }] } };
    const fetchImpl = async (url, init) => { const path = new URL(url).pathname; calls.push([init.method, path]); return { ok: true, json: async () => answers[path] }; };
    const env = { RULE_BOT_ID: 'momentum-rules', MAX_ORDER_PAISE: '500000', PRINCIPALS_JSON: JSON.stringify([{ role: 'owner', token: 'o' }, { role: 'researcher', token: 'r' },
      { role: 'evaluator', token: 'e' }, { role: 'trader', token: 't', botId: 'momentum-rules' }]) };
    const report = await run(env, { fetchImpl, root, now: WED_MORNING });
    assert.deepEqual(report.checks.filter(c => c.status !== 'GO').map(c => c.id), ['last-cycle', 'backup']);
    assert.match(report.checks.find(c => c.id === 'last-cycle').detail, /failed news-x/);
    assert.ok(calls.every(([method, path]) => method === 'GET' || ['/v1/owner/digest', '/v1/releases/view'].includes(path))); // read-only routes
    assert.equal(JSON.parse(await readFile(join(root, '.local', 'readiness', '2026-10-14.json'), 'utf8')).verdict, 'GO WITH WARNINGS');
  } finally { await rm(root, { recursive: true, force: true }); }
});
