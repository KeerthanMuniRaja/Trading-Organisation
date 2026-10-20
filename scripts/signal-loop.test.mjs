// End to end: the real compiled backend (in process, test credentials) and the real Python signal scorer.
// A reviewed proposal whose horizon has passed gets price evidence, independent verification and a scored outcome.
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

test('a due proposal is scored end to end by the real scorer against the real backend', { skip: !existsSync(PY) && 'research environment not installed' }, async () => {
  const f = await fixture();
  const app = await createApp(f.cfg, f.db, true);
  const dir = await mkdtemp(join(tmpdir(), 'loop-'));
  try {
    await app.listen(0, '127.0.0.1');
    const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    await f.org.sources(owner, key(), { id: 'market-yahoo-daily', name: 'Yahoo daily closes', url: 'https://finance.yahoo.com', approved: true });
    await f.org.bot(owner, key(), { id: 'bot-one', name: 'Allocator', department: 'desk', specialty: 'alloc', method: 'llm', contribution: 'Loop fixture', budgetPaise: '0' });
    // a proposal made 10 days ago with a 5-day horizon, reviewed at a 248000-paise reference (history cannot be back-dated through the API)
    const signalId = crypto.randomUUID();
    await f.db.transaction(async tx => {
      await tx.query(`INSERT INTO trade_signals(id,bot_id,symbol,action,horizon_days,conviction,probability_pct,thesis,invalidation,expires_at,author,content_hash,created_at)
        VALUES($1,'bot-one','RELIANCE','enter-long',5,'high',70,'Trend','Below 200-day average',now()-interval '8 days','trader',$2,now()-interval '10 days')`, [signalId, key()]);
      await tx.query(`INSERT INTO trade_signal_reviews(id,signal_id,outcome,reasons,reference_price_paise,rules_version,reviewer)
        VALUES($1,$2,'rejected',ARRAY['test']::text[],248000,'signal-risk-v2','evaluator')`, [crypto.randomUUID(), signalId]);
    });
    const day = n => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
    const bars = [9, 6, 5, 4, 3, 2].map((ago, i) => ({ date: day(ago), openPaise: 250000 + i * 1000, highPaise: 250000 + i * 1000,
      lowPaise: 250000 + i * 1000, closePaise: 250000 + i * 1000, volume: 1000 }));
    await writeFile(join(dir, 'RELIANCE.NS-1d.json'), JSON.stringify({ symbol: 'RELIANCE.NS', bars }));
    const env = { ...process.env, API_URL: base, PRINCIPALS_JSON: JSON.stringify(f.cfg.principals) };
    const { stdout } = await promisify(execFile)(PY, ['integrations/trading-desk/signal_scorer.py', '--source', 'market-yahoo-daily', '--cache', dir], { env });
    const scored = stdout.trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    assert.equal(scored[0].state, 'scored');
    const row = (await f.db.transaction(tx => tx.query(`SELECT o.exit_price_paise::text AS exit,o.correct,e.status FROM trade_signal_outcomes o
      JOIN evidence e ON e.id=o.evidence_id WHERE o.signal_id=$1`, [signalId]))).rows[0];
    assert.equal(row.status, 'verified'); // the checker verified the reporter's evidence
    assert.ok(Number(row.exit) >= 250000);
    assert.equal(row.correct, (Number(row.exit) - 248000) * 10000 / 248000 > 30);
    const again = await promisify(execFile)(PY, ['integrations/trading-desk/signal_scorer.py', '--source', 'market-yahoo-daily', '--cache', dir], { env });
    assert.match(again.stdout, /0 scored, 0 failed/); // already scored: nothing repeats
    assert.equal((await f.ops.verifyAudit(owner)).valid, true);
  } finally { await app.close(); await f.db.close(); await rm(dir, { recursive: true, force: true }); }
});
