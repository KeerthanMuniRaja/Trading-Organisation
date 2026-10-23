import test from 'node:test';
import assert from 'node:assert/strict';
import { riskStats } from '../src/paper-performance.js';

test('risk figures come from daily equity: volatility, Sharpe, 95% one-day VaR and the worst fall', () => {
  assert.deepEqual(riskStats([100n, 101n, 102n]), { days: 2, volatilityPct: null, sharpe: null, var95Pct: null, maxDrawdownPct: 0 }); // too few days
  // 40 days alternating +1% and -0.5%: positive drift, a known spread, and a worst day of -0.5%
  const equity = [1_000_000n];
  for (let i = 0; i < 40; i++) equity.push(equity[equity.length - 1]! * (i % 2 ? 995n : 1010n) / 1000n);
  const r = riskStats(equity);
  assert.equal(r.days, 40);
  assert.ok(r.volatilityPct! > 11 && r.volatilityPct! < 13, String(r.volatilityPct)); // about 0.76% a day, x sqrt(252)
  assert.ok(r.sharpe! > 4, String(r.sharpe));
  assert.equal(r.var95Pct, 0.5);
  assert.equal(r.maxDrawdownPct, 0.5);
  const flat = riskStats(Array.from({ length: 30 }, () => 500_000n));
  assert.deepEqual([flat.volatilityPct, flat.sharpe, flat.var95Pct], [0, null, 0]); // no movement, no Sharpe
});
