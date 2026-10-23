import test from 'node:test';
import assert from 'node:assert/strict';
import { withDebaters } from './debate-setup.mjs';

const ENV = `PRINCIPALS_JSON='[{"id":"o","role":"owner","token":"x"}]'\nMAX_ORDER_PAISE=500000\n`;

test('both debaters get one credential each and their settings, once', () => {
  const updated = withDebaters(ENV);
  const lines = updated.split('\n');
  const principals = JSON.parse(lines[0].slice('PRINCIPALS_JSON='.length).replace(/^'(.*)'$/, '$1'));
  assert.deepEqual(principals.filter(p => p.role === 'trader').map(p => p.botId), ['debate-bull', 'debate-bear']);
  assert.ok(lines.includes('DEBATE_BULL_BOT=debate-bull') && lines.includes('DEBATE_BEAR_BOT=debate-bear'));
  assert.ok(lines.includes('MAX_ORDER_PAISE=500000'));
  assert.equal(withDebaters(updated), null); // already configured: nothing changes
});
