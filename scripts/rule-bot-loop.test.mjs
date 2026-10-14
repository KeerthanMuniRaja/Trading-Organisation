// End to end: the real compiled backend (in process, test credentials), the real rule bot and the real end-of-day trader.
// The rule bot ranks the shares, has the ranking reported and verified, and proposes the top 3 under its own credential;
// the end-of-day trader then reviews those proposals at verified closes. A second run in the same month proposes nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fixture, owner, key } from '../backend/dist/test/helpers.js';
import { createApp } from '../backend/dist/src/app.js';

const PY = resolve('.local', 'replay-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const GROWTH = { 'RELIANCE.NS': 1.3, 'HDFCBANK.NS': 1.02, 'ICICIBANK.NS': 1.25, 'INFY.NS': 0.95, 'SBIN.NS': 1.01, 'ITC.NS': 1.05, 'AXISBANK.NS': 0.9, 'NTPC.NS': 1.2 };

test('the rule bot proposes its top 3 with verified evidence and the desk reviews them at verified closes', { skip: !existsSync(PY) && 'research environment not installed' }, async () => {
  const f = await fixture();
  const app = await createApp(f.cfg, f.db, true);
  const dir = await mkdtemp(join(tmpdir(), 'rulebot-'));
  try {
    await app.listen(0, '127.0.0.1');
    const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    await f.org.sources(owner, key(), { id: 'market-yahoo-daily', name: 'Yahoo daily', url: 'https://finance.yahoo.com', approved: true });
    await f.deposit('5000000');
    await f.org.bot(owner, key(), { id: 'bot-one', name: 'Momentum rules', department: 'desk', specialty: 'momentum', method: 'rules', contribution: 'Rule bot fixture', budgetPaise: '3000000' });
    await f.db.transaction(tx => tx.query("UPDATE bots SET state='paper' WHERE id='bot-one'"));
    const day = n => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
    for (const [symbol, growth] of Object.entries(GROWTH)) {
      const bars = Array.from({ length: 140 }, (_, i) => {
        const p = Math.round(10000 * growth ** (i / 139));
        return { date: day(140 - i), openPaise: p, highPaise: p, lowPaise: p, closePaise: p, volume: 1000 };
      });
      await writeFile(join(dir, `${symbol}-1d.json`), JSON.stringify({ symbol, bars }));
    }
    const env = { ...process.env, API_URL: base, PRINCIPALS_JSON: JSON.stringify(f.cfg.principals) };
    const run = async script => (await promisify(execFile)(PY, [`integrations/trading-desk/${script}.py`, ...(script === 'rule_bot' ? ['--bot', 'bot-one', '--state', join(dir, 'state')] : []),
      '--source', 'market-yahoo-daily', '--cache', dir], { env })).stdout;

    const first = JSON.parse(await run('rule_bot'));
    assert.equal(first.state, 'proposed');
    assert.deepEqual(first.proposals.map(p => [p.action, p.symbol]), [['enter-long', 'RELIANCE'], ['enter-long', 'ICICIBANK'], ['enter-long', 'NTPC']]);
    const stored = (await f.db.transaction(tx => tx.query(`SELECT s.symbol,s.model,s.target_weight_pct,e.status,e.content FROM trade_signals s
      JOIN trade_signal_evidence l ON l.signal_id=s.id JOIN evidence e ON e.id=l.evidence_id ORDER BY s.symbol`))).rows;
    assert.equal(stored.length, 3);
    assert.ok(stored.every(r => r.model === 'rules:top3-momentum-6m' && r.target_weight_pct === 33 && r.status === 'verified'));
    assert.match(stored[0].content, /1\. NSE:RELIANCE \+/);

    const eod = (await run('eod_trader')).trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const reviews = eod.filter(l => l.step === 'review');
    assert.deepEqual(reviews.map(r => r.state), ['accepted', 'accepted', 'accepted']);
    // three equal thirds of the budget, as in the backtest
    assert.ok(reviews.every(r => r.reasons.includes('priced-from-verified-close') && r.reasons.includes('sized-by-target-weight')), JSON.stringify(reviews));

    assert.equal(JSON.parse(await run('rule_bot')).state, 'month-complete'); // one decision per month: nothing more to send
    assert.equal((await f.ops.verifyAudit(owner)).valid, true);
  } finally { await app.close(); await f.db.close(); await rm(dir, { recursive: true, force: true }); }
});
