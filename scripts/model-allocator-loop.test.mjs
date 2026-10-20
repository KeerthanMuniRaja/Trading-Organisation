// End to end: the real compiled backend (in process, test credentials), a month as the model allocator's forward test
// would have decided it, the real model_allocator step and the real end-of-day trader. No model is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fixture, owner, key } from '../backend/dist/test/helpers.js';
import { createApp } from '../backend/dist/src/app.js';

const PY = resolve('.local', 'replay-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const SYMBOLS = ['AXISBANK.NS', 'HDFCBANK.NS', 'ICICIBANK.NS', 'INFY.NS', 'ITC.NS', 'NTPC.NS', 'RELIANCE.NS', 'SBIN.NS'];
// what ai_allocator would have stored for the latest day: the facts it showed the model, and the model's valid reply
const DECIDE = `
import json, sys
from pathlib import Path
sys.path.insert(0, 'integrations/trading-desk')
import ai_allocator as ai, daily, portfolio_daily as pd
base = Path(sys.argv[1])
dates, table = pd.aligned(daily.load(sorted(daily.datasets.UNIVERSE), base / 'daily'))
letters = ai.mapping('ai-e2e', daily.datasets.UNIVERSE)
weights = {k: 0 for k in ai.LETTERS}; weights.update(A=20, B=20, C=20)
state = {'name': 'ai-e2e', 'model': 'Qwen3.5-4B-Q4_K_M', 'promptVersion': ai.PROMPT_VERSION, 'from': dates[-1], 'weights': {},
         'months': {dates[-1]: {'outcome': 'valid', 'weights': weights, 'cash': 40, 'scaledDown': False, 'rationale': 'Leaders',
                                'facts': ai.brief(table, dates, len(dates) - 1, letters)}}}
(base / 'runs' / 'ai-e2e').mkdir(parents=True)
(base / 'runs' / 'ai-e2e' / 'decisions.json').write_text(json.dumps(state), encoding='utf-8')
print(json.dumps([letters[k].removesuffix('.NS') for k in 'ABC']))
`;

test('the model allocator\'s decided month is proposed with verified facts and reviewed by the desk', { skip: !existsSync(PY) && 'research environment not installed' }, async () => {
  const f = await fixture();
  const app = await createApp(f.cfg, f.db, true);
  const dir = await mkdtemp(join(tmpdir(), 'allocator-'));
  try {
    await app.listen(0, '127.0.0.1');
    const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    await f.org.sources(owner, key(), { id: 'market-yahoo-daily', name: 'Yahoo daily', url: 'https://finance.yahoo.com', approved: true });
    await f.deposit('5000000');
    await f.org.bot(owner, key(), { id: 'bot-one', name: 'AI allocator', department: 'portfolio', specialty: 'allocation', method: 'llm', contribution: 'Allocator fixture', budgetPaise: '3000000' });
    await f.db.transaction(tx => tx.query("UPDATE bots SET state='paper' WHERE id='bot-one'"));
    await mkdir(join(dir, 'daily'));
    const day = n => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
    for (const [n, symbol] of SYMBOLS.entries()) {
      const bars = Array.from({ length: 300 }, (_, i) => {
        const p = 10000 + n * 100 + i * (n - 3) * 2;
        return { date: day(300 - i), openPaise: p, highPaise: p + 5, lowPaise: p - 5, closePaise: p, volume: 1000 };
      });
      await writeFile(join(dir, 'daily', `${symbol}-1d.json`), JSON.stringify({ schemaVersion: 1, symbol, interval: '1d', priceBasis: 'adjusted', source: 'synthetic-test', bars }));
    }
    const exec = promisify(execFile);
    const chosen = JSON.parse((await exec(PY, ['-c', DECIDE, dir])).stdout);
    const env = { ...process.env, API_URL: base, PRINCIPALS_JSON: JSON.stringify(f.cfg.principals) };
    const propose = async () => JSON.parse((await exec(PY, ['integrations/trading-desk/model_allocator.py', '--bot', 'bot-one', '--run', 'ai-e2e',
      '--source', 'market-yahoo-daily', '--cache', join(dir, 'daily'), '--runs', join(dir, 'runs')], { env })).stdout);

    const first = await propose();
    assert.equal(first.state, 'proposed');
    assert.deepEqual(first.proposals.map(p => p[1]).sort(), chosen.sort());
    const stored = (await f.db.transaction(tx => tx.query(`SELECT s.model,s.target_weight_pct,e.status,e.content FROM trade_signals s
      JOIN trade_signal_evidence l ON l.signal_id=s.id JOIN evidence e ON e.id=l.evidence_id`))).rows;
    assert.ok(stored.every(r => r.model === 'Qwen3.5-4B-Q4_K_M' && r.target_weight_pct === 20 && r.status === 'verified'));
    assert.match(stored[0].content, /^Monthly allocator brief for the decision on/);

    const eod = (await exec(PY, ['integrations/trading-desk/eod_trader.py', '--source', 'market-yahoo-daily', '--cache', join(dir, 'daily')], { env })).stdout
      .trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    assert.deepEqual(eod.filter(l => l.step === 'review').map(l => l.state), ['accepted', 'accepted', 'accepted']);
    assert.equal((await propose()).state, 'already-proposed'); // once per decided month
    assert.equal((await f.ops.verifyAudit(owner)).valid, true);
  } finally { await app.close(); await f.db.close(); await rm(dir, { recursive: true, force: true }); }
});
