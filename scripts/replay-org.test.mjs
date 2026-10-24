import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { indiaTime, replaySettings, sessions } from './replay-org.mjs';

test('the replay runs each trading day after its close, on its own settings, never the live ones', () => {
  assert.equal(indiaTime('2025-04-01', 16, 10), '2025-04-01T10:40:00.000Z');   // 16:10 IST, after the close
  const bars = ['2025-03-31', '2025-04-01', '2025-04-02', '2025-04-04', '2025-05-02'].map(date => ({ date }));
  assert.deepEqual(sessions(bars, '2025-04-01', '2025-04-30'), ['2025-04-01', '2025-04-02', '2025-04-04']); // holidays simply have no session
  const pem = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const env = Object.fromEntries(replaySettings(pem).split('\n').filter(Boolean).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  assert.equal(env.APP_MODE, 'paper');
  assert.equal(env.PORT, '3100');                                    // never the live backend's port
  assert.match(env.DATABASE_PATH, /replay/);                        // the replay clock refuses anything else
  const principals = JSON.parse(env.PRINCIPALS_JSON.replace(/^'|'$/g, ''));
  assert.deepEqual(principals.map(p => p.role).sort(), ['coordinator', 'evaluator', 'market', 'owner', 'researcher', 'treasury']);
  assert.ok(principals.every(p => p.token.length >= 43));            // fresh credentials, valid for the backend
  assert.notEqual(JSON.parse(replaySettings(pem).match(/PRINCIPALS_JSON='(.*)'/)[1])[0].token, principals[0].token); // new every time
  assert.equal(Buffer.from(env.OWNER_PUBLIC_KEY_BASE64, 'base64').toString(), pem);
});
