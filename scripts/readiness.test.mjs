import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UNIVERSE, assess, expectedSession, parseHolidays, run, verdict } from './readiness.mjs';

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

test('an owner calendar skips exchange holidays; a broken or outdated one is never trusted', () => {
  // fixture dates for the test only, not the real exchange calendar
  const cal = parseHolidays(JSON.stringify({ source: 'test fixture', years: [2026], days: ['2026-10-13'] }));
  assert.equal(expectedSession(WED_MORNING, cal.days), '2026-10-12'); // the listed holiday is not a session
  const onHoliday = assess({ ...ready, prices: prices('2026-10-12'), holidays: cal }, WED_MORNING);
  assert.equal(status(onHoliday, 'market-data'), 'GO'); // yesterday was a holiday, so the 12th is current
  const holidayToday = assess({ ...ready, holidays: parseHolidays(JSON.stringify({ source: 'fixture', years: [2026], days: ['2026-10-14'] })) }, WED_MORNING);
  assert.match(holidayToday.find(c => c.id === 'calendar').detail, /today \(2026-10-14\) is an NSE trading holiday/);
  assert.equal(verdict(holidayToday), 'GO');
  for (const bad of ['nope', '{"years":[2026],"days":[]}', '{"source":"x","years":[2026],"days":["2026-02-30"]}', '{"source":"x","years":[2025],"days":["2026-01-26"]}'])
    assert.ok(parseHolidays(bad).error, bad);
  assert.equal(status(assess({ ...ready, holidays: { error: 'not valid JSON' } }, WED_MORNING), 'calendar'), 'WARN');
  assert.equal(status(assess({ ...ready, holidays: parseHolidays('{"source":"x","years":[2025],"days":[]}') }, WED_MORNING), 'calendar'), 'WARN'); // not this year
  assert.equal(assess(ready, WED_MORNING).find(c => c.id === 'calendar'), undefined); // no calendar: behaviour unchanged
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
  const drifted = assess({ ...ready, ruleBot: { ...ready.ruleBot, gate: 'its code or rule differs from the authorised release v1' } }, WED_MORNING).find(c => c.id === 'rule-bot');
  assert.deepEqual([drifted.status, drifted.action], ['WARN', 'npm.cmd run rulebot -- apply --yes (registers, evaluates and activates a release for the current code)']);
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
    const gated = [];
    const report = await run(env, { fetchImpl, root, now: WED_MORNING, gate: async botId => { gated.push(botId); return null; } });
    assert.deepEqual(gated, ['momentum-rules']); // the cycle's own release check is asked before the day starts
    assert.deepEqual(report.checks.filter(c => c.status !== 'GO').map(c => c.id), ['last-cycle', 'backup']);
    assert.match(report.checks.find(c => c.id === 'last-cycle').detail, /failed news-x/);
    assert.ok(calls.every(([method, path]) => method === 'GET' || ['/v1/owner/digest', '/v1/releases/view'].includes(path))); // read-only routes
    assert.equal(JSON.parse(await readFile(join(root, '.local', 'readiness', '2026-10-14.json'), 'utf8')).verdict, 'GO WITH WARNINGS');
  } finally { await rm(root, { recursive: true, force: true }); }
});
