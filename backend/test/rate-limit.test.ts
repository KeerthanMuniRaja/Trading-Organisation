import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from './helpers.js';
import { Database } from '../src/database.js';
import { createApp } from '../src/app.js';

test('anonymous traffic is rate limited; the organisation\'s own authenticated workers are not cut off', async () => {
  const { cfg } = config(), db = await Database.open(), app = await createApp(cfg, db, true);
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const token = cfg.principals.find(p => p.role === 'researcher')!.token;
    const burst = async (headers: Record<string, string>) => {
      const statuses = [];
      for (let i = 0; i < 130; i++) statuses.push((await fetch(base + '/v1/paper/marks', { headers })).status);
      return statuses;
    };
    const worker = await burst({ Authorization: 'Bearer ' + token });
    assert.ok(worker.every(s => s === 200), `authenticated: ${[...new Set(worker)]}`);
    const guessing = await burst({ Authorization: 'Bearer ' + 'x'.repeat(43) });
    assert.ok(guessing.includes(429), 'a wrong token is still throttled');
    assert.ok(guessing.every(s => s === 401 || s === 429));
  } finally { await app.close(); await db.close(); }
});
