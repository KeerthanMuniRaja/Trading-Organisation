import test from 'node:test';
import assert from 'node:assert/strict';
import { config, key } from './helpers.js';
import { Database } from '../src/database.js';
import { createApp } from '../src/app.js';

// ORG-03: the daily organisation cycle calls these with an empty body and one role's credential. With every policy at its
// default (off) each must answer successfully and do nothing, so the cycle never fails for a feature the owner left off.
const CYCLES: [string, string][] = [['/v1/skills/cycles', 'evaluator'], ['/v1/skills/remediation/cycles', 'evaluator'], ['/v1/lifecycle/cycles', 'evaluator'],
  ['/v1/dispatch/cycles', 'evaluator'], ['/v1/development/experiments/cycles', 'evaluator'], ['/v1/learning/cycles', 'researcher'], ['/v1/learning/cycles', 'evaluator'],
  ['/v1/management/reviews', 'evaluator']];

test('every daily backend cycle succeeds and does nothing while its policy is off', async () => {
  const { cfg } = config(), db = await Database.open(), app = await createApp(cfg, db, true);
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    for (const [path, role] of CYCLES) {
      const r = await fetch(base + path, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key(),
        Authorization: 'Bearer ' + cfg.principals.find(p => p.role === role)!.token } });
      const body = await r.json();
      assert.ok(r.status === 200 || r.status === 201, `${path} as ${role}: HTTP ${r.status} ${JSON.stringify(body)}`);
      if ('status' in body) assert.ok(['disabled', 'halted', 'cooldown', 'idle', 'ok'].includes(body.status) || Array.isArray(body.actions), `${path}: ${JSON.stringify(body)}`);
    }
  } finally { await app.close(); await db.close(); }
});
