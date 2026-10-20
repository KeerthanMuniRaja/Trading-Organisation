// The activation path end to end: the real compiled backend (in process, test credentials), the real activation steps and
// the real rule bot proposing through the release gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { BOT, apply, fitnessFrom, identity, withCredential } from './activate-rule-bot.mjs';

const PY = resolve('.local', 'replay-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const STUDY = { from: '2022-08', through: '2026-09', byRule: { 'top3-momentum-6m': { 'all months': { months: 50, ahead: 32, behind: 18 } } } };

test('the credential step adds one bound trader and RULE_BOT_ID, keeps everything else, and never repeats', () => {
  const env = "APP_MODE=paper\nPRINCIPALS_JSON='[{\"id\":\"o\",\"role\":\"owner\",\"token\":\"t\"}]'\nMAX_ORDER_PAISE=100000\n";
  const once = withCredential(env, 'momentum-rules', 'x'.repeat(43));
  const principals = JSON.parse(once.match(/^PRINCIPALS_JSON='(.*)'$/m)[1]);
  assert.deepEqual(principals.map(p => [p.role, p.botId]), [['owner', undefined], ['trader', 'momentum-rules']]);
  assert.match(once, /^MAX_ORDER_PAISE=100000$/m);
  assert.match(once, /^RULE_BOT_ID=momentum-rules$/m);
  assert.equal(withCredential(once, 'momentum-rules'), null);
  assert.throws(() => withCredential(once.replace('RULE_BOT_ID=momentum-rules', 'RULE_BOT_ID=other'), 'momentum-rules'), /another bot/);
});

test('the fitness report is the study record against the basket, over whole months', () => {
  assert.deepEqual(fitnessFrom(STUDY, 'rules:top3-momentum-6m'), { botId: 'momentum-rules', role: 'allocator', baseline: 'equal-weight-basket',
    model: 'rules:top3-momentum-6m', judged: 50, wins: 32, losses: 18, testName: 'regime-study 2022-08..2026-09 monthly vs basket (seen data)',
    periodFrom: '2022-08-01', periodTo: '2026-09-30' });
  assert.throws(() => fitnessFrom({ byRule: {} }, 'm'), /no 'top3-momentum-6m' record/);
});

test('activation qualifies the rule bot, reruns change nothing, and its proposals pass the release gate', { skip: !existsSync(PY) && 'research environment not installed' }, async () => {
  const { fixture, owner, key } = await import('../backend/dist/test/helpers.js');
  const { createApp } = await import('../backend/dist/src/app.js');
  const f = await fixture();
  f.cfg.principals.push({ id: 'rule-trader', role: 'trader', token: 'rule-bot-trader-token-'.padEnd(48, 'r'), botId: BOT.id });
  const app = await createApp(f.cfg, f.db, true);
  const dir = await mkdtemp(join(tmpdir(), 'activate-'));
  try {
    await app.listen(0, '127.0.0.1');
    const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    await f.org.sources(owner, key(), { id: 'market-yahoo-daily', name: 'Yahoo daily', url: 'https://finance.yahoo.com', approved: true });
    const env = { ...process.env, API_URL: base, PRINCIPALS_JSON: JSON.stringify(f.cfg.principals) };
    const id = await identity(PY);
    const first = await apply(env, { id, study: STUDY });
    assert.equal(first.activated, true);
    assert.deepEqual(first.steps.map(s => s[0]), ['bot', 'fitness', 'release', 'evaluation', 'stage', 'qualify']);
    assert.match(first.steps[1][1], /^adds-value/);
    const again = await apply(env, { id, study: STUDY });
    assert.deepEqual(again.steps.map(s => s[1]).slice(2), ['v1', 'active-eligible true', 'already active', 'already paper']);
    const audit = (await f.db.transaction(tx => tx.query("SELECT count(*)::int AS n FROM audit_events WHERE action IN ('bot.qualified.paper','bot.release.staged')"))).rows[0];
    assert.equal(audit.n, 2); // the rerun wrote nothing

    const day = n => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
    for (const [symbol, growth] of [['RELIANCE.NS', 1.3], ['ICICIBANK.NS', 1.2], ['SBIN.NS', 1.1], ['ITC.NS', 0.9]]) {
      const bars = Array.from({ length: 140 }, (_, i) => { const p = Math.round(10000 * growth ** (i / 139)); return { date: day(140 - i), openPaise: p, highPaise: p, lowPaise: p, closePaise: p, volume: 1 }; });
      await writeFile(join(dir, `${symbol}-1d.json`), JSON.stringify({ symbol, bars }));
    }
    const { stdout } = await promisify(execFile)(PY, ['integrations/trading-desk/rule_bot.py', '--bot', BOT.id, '--source', 'market-yahoo-daily', '--cache', dir,
      '--state', join(dir, 'state')], { env });
    const result = JSON.parse(stdout);
    assert.deepEqual(result.proposals.map(p => p.symbol), ['RELIANCE', 'ICICIBANK', 'SBIN']);
    const linked = (await f.db.transaction(tx => tx.query('SELECT count(*)::int AS n FROM trade_signals WHERE bot_id=$1 AND release_id IS NOT NULL', [BOT.id]))).rows[0];
    assert.equal(linked.n, 3); // every proposal is tied to the active release
  } finally { await app.close(); await f.db.close(); await rm(dir, { recursive: true, force: true }); }
});
