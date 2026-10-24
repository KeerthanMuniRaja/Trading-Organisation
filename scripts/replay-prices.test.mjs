import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lastClosedDay, writeUpTo } from './replay-prices.mjs';
import { planSteps, verifyMarketData } from './organisation-cycle.mjs';

test('a replayed day sees only sessions that had closed by then, never the future', async () => {
  // 15:59 IST on 15 Mar is before the close: the last closed session is the 14th; from 16:00 it is the 15th
  assert.equal(lastClosedDay(Date.parse('2024-03-15T10:29:00Z')), '2024-03-14');
  assert.equal(lastClosedDay(Date.parse('2024-03-15T10:30:00Z')), '2024-03-15');
  assert.equal(lastClosedDay(Date.parse('2024-03-15T20:00:00Z')), '2024-03-15'); // 01:30 IST on the 16th: the 16th has not closed yet
  const dir = await mkdtemp(join(tmpdir(), 'replay-prices-'));
  try {
    const full = join(dir, 'full'), daily = join(dir, 'daily');
    await mkdir(full, { recursive: true });
    await writeFile(join(full, 'SBIN.NS-1d.json'), JSON.stringify({ symbol: 'SBIN.NS', bars: ['2024-03-13', '2024-03-14', '2024-03-15', '2024-03-18'].map(date => ({ date })) }));
    const r = await writeUpTo(full, daily, Date.parse('2024-03-15T11:00:00Z'));
    assert.equal(r.through, '2024-03-15');
    const kept = JSON.parse(await readFile(join(daily, 'SBIN.NS-1d.json'), 'utf8')).bars.map(b => b.date);
    assert.deepEqual(kept, ['2024-03-13', '2024-03-14', '2024-03-15']);
    assert.equal(verifyMarketData(JSON.stringify(r.shares)).status, 'done'); // the cycle's own check accepts it
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('in a replay the cycle cuts prices locally instead of downloading them', async () => {
  const before = process.env.REPLAY_PRICES;
  try {
    process.env.REPLAY_PRICES = '/x/full';
    const step = (await planSteps({ root: '/nowhere' })).find(s => s.id === 'market-data');
    assert.ok(step.args[0].endsWith('replay-prices.mjs') && step.args[1] === '/x/full');
    delete process.env.REPLAY_PRICES;
    assert.ok((await planSteps({ root: '/nowhere' })).find(s => s.id === 'market-data').args[0].endsWith('daily.py'));
  } finally { if (before === undefined) delete process.env.REPLAY_PRICES; else process.env.REPLAY_PRICES = before; }
});
