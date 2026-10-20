import test from 'node:test';
import assert from 'node:assert/strict';
import { addCredential } from './bot-credential.mjs';

const ENV = `API_URL=http://127.0.0.1:3000\nPRINCIPALS_JSON='[{"id":"o","role":"owner","token":"x"},{"id":"t","role":"trader","token":"y","botId":"momentum-rules"}]'\nMAX_ORDER_PAISE=500000\n`;

test('one trader credential per bot is added, other lines and credentials untouched', () => {
  const updated = addCredential(ENV, 'rnd-momentum-6m-top2', 'fixed-token');
  const principals = JSON.parse(updated.split('\n')[1].slice('PRINCIPALS_JSON='.length).replace(/^'(.*)'$/, '$1'));
  assert.deepEqual(principals.map(p => [p.role, p.botId ?? null]), [['owner', null], ['trader', 'momentum-rules'], ['trader', 'rnd-momentum-6m-top2']]);
  assert.equal(principals[2].token, 'fixed-token');
  assert.equal(updated.split('\n')[2], 'MAX_ORDER_PAISE=500000');
  assert.equal(addCredential(updated, 'rnd-momentum-6m-top2'), null); // already there: nothing changes
  assert.equal(addCredential(ENV, 'momentum-rules'), null);
  assert.throws(() => addCredential(ENV, '../x'), /bot id/);
  assert.throws(() => addCredential('NOTHING=1', 'a'), /PRINCIPALS_JSON/);
  assert.notEqual(JSON.parse(addCredential(ENV, 'b').split('\n')[1].slice(16).slice(1, -1))[2].token, JSON.parse(addCredential(ENV, 'b').split('\n')[1].slice(16).slice(1, -1))[2].token); // random each time
});
