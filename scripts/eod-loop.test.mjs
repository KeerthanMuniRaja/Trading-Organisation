// End to end: the real compiled backend (in process, test credentials) and the real end-of-day trader.
// A proposal is reviewed at the verified latest close; a proposal reviewed earlier is executed at the verified next open.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fixture, owner, trader, key } from '../backend/dist/test/helpers.js';
import { createApp } from '../backend/dist/src/app.js';
import { TradeSignals } from '../backend/dist/src/trade-signals.js';
import { PaperPerformance } from '../backend/dist/src/paper-performance.js';

const PY = resolve('.local', 'replay-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

test('the end-of-day trader reviews at the verified close and executes at the verified next open', { skip: !existsSync(PY) && 'research environment not installed' }, async () => {
  const f = await fixture();
  const app = await createApp(f.cfg, f.db, true);
  const dir = await mkdtemp(join(tmpdir(), 'eod-'));
  try {
    await app.listen(0, '127.0.0.1');
    const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    await f.org.sources(owner, key(), { id: 'market-yahoo-daily', name: 'Yahoo daily', url: 'https://finance.yahoo.com', approved: true });
    const e = await f.evidence();
    await f.deposit('500000');
    await f.org.bot(owner, key(), { id: 'bot-one', name: 'Allocator', department: 'desk', specialty: 'alloc', method: 'rules', contribution: 'EOD fixture', budgetPaise: '1000000' });
    await f.db.transaction(tx => tx.query("UPDATE bots SET state='paper' WHERE id='bot-one'"));
    const day = n => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
    const bars = [6, 5, 4, 3, 2, 1].map((ago, i) => ({ date: day(ago), openPaise: 10000 + i * 100, highPaise: 10600, lowPaise: 9900, closePaise: 10050 + i * 100, volume: 1000 }));
    await writeFile(join(dir, 'RELIANCE.NS-1d.json'), JSON.stringify({ symbol: 'RELIANCE.NS', bars }));
    const signals = new TradeSignals(f.db, f.cfg);
    const base_ = { botId: 'bot-one', symbol: 'RELIANCE', action: 'enter-long', horizonDays: 20, conviction: 'medium', invalidation: 'Breaks support',
      expiresAt: new Date(Date.now() + 5 * 86_400_000).toISOString(), evidenceIds: [e.evidenceId] };
    const fresh = await signals.propose(trader, key(), { ...base_, thesis: 'Proposed today' });
    // a proposal accepted three days ago (history cannot be back-dated through the API): its next open is two days ago
    const earlier = await signals.propose(trader, key(), { ...base_, thesis: 'Accepted earlier' });
    await f.db.transaction(tx => tx.query(`INSERT INTO trade_signal_reviews(id,signal_id,outcome,reasons,side,quantity,reference_price_paise,rules_version,reviewer,created_at)
      VALUES($1,$2,'accepted',ARRAY['sized-by-available-capital']::text[],'buy',10,10250,'signal-risk-v2','evaluator',now()-interval '3 days')`, [crypto.randomUUID(), earlier.id]));

    const env = { ...process.env, API_URL: base, PRINCIPALS_JSON: JSON.stringify(f.cfg.principals) };
    const { stdout } = await promisify(execFile)(PY, ['integrations/trading-desk/eod_trader.py', '--source', 'market-yahoo-daily', '--cache', dir], { env });
    const lines = stdout.trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const review = lines.find(l => l.step === 'review' && l.signalId === fresh.id);
    assert.equal(review.state, 'accepted');
    assert.ok(review.reasons.includes('priced-from-verified-close'));
    const executed = lines.find(l => l.step === 'execute' && l.signalId === earlier.id);
    // the first session whose 09:15 IST open is strictly after the review (three days ago at this time of day)
    const reviewedAt = Date.now() - 3 * 86_400_000;
    const expected = bars.find(b => Date.parse(b.date + 'T03:45:00Z') > reviewedAt);
    assert.deepEqual([executed.state, executed.quantity, executed.pricePaise], ['executed', '10', String(expected.openPaise)]);
    // the freshly reviewed proposal waits for an open that does not exist yet
    assert.equal(lines.find(l => l.step === 'execute' && l.signalId === fresh.id)?.state ?? 'not-listed-yet', 'waiting');
    const position = (await f.db.transaction(tx => tx.query("SELECT quantity::text AS q FROM positions WHERE bot_id='bot-one' AND symbol='RELIANCE'"))).rows[0];
    assert.equal(position.q, '10');
    // the position is valued at the verified latest close, not held at cost
    assert.deepEqual(lines.filter(l => l.step === 'mark').map(l => [l.symbol, l.state, l.pricePaise]), [['RELIANCE', 'marked', String(bars.at(-1).closePaise)]]);
    const held = (await new PaperPerformance(f.db).report(owner)).bots.find(b => b.botId === 'bot-one').openPositions[0];
    assert.equal(held.valuation, 'verified-close');
    const again = await promisify(execFile)(PY, ['integrations/trading-desk/eod_trader.py', '--source', 'market-yahoo-daily', '--cache', dir], { env });
    assert.match(again.stdout, /executed 0/); // nothing repeats
    assert.equal((await f.ops.verifyAudit(owner)).valid, true);
  } finally { await app.close(); await f.db.close(); await rm(dir, { recursive: true, force: true }); }
});
