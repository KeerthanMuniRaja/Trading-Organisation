import test from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, createBots, withMembers } from './member-setup.mjs';

const ENV = `PRINCIPALS_JSON='[{"id":"o","role":"owner","token":"x"}]'\n`;

test('each preset adds one credential per member and the setting that names it, once', () => {
  const updated = withMembers(ENV, PRESETS.tradingagents);
  assert.ok(updated.includes('TA_BOT_ID=tradingagents'));
  assert.equal(JSON.parse(updated.split('\n')[0].slice(16).slice(1, -1)).filter(p => p.botId === 'tradingagents').length, 1);
  assert.equal(withMembers(updated, PRESETS.tradingagents), null);
  assert.ok(withMembers(updated, PRESETS.debaters)); // another preset is independent
});

test('bots are created with zero budget by the owner, and existing ones are left alone', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push([init.method ?? 'GET', init.body ? JSON.parse(init.body) : null, init.headers.Authorization]);
    return { ok: true, json: async () => [{ id: 'debate-bull' }], text: async () => '{}' };
  };
  const out = await createBots({ PRINCIPALS_JSON: '[{"role":"owner","token":"o"}]' }, PRESETS.debaters, fetchImpl);
  assert.deepEqual(out, ['debate-bull: exists', 'debate-bear: created (school, zero budget)']);
  const created = sent.find(s => s[0] === 'POST');
  assert.deepEqual([created[1].id, created[1].budgetPaise, created[2]], ['debate-bear', '0', 'Bearer o']);
});
