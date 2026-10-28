import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBundle, secretsBundle, supervisorState } from './handover.mjs';

test('the secret backup restores the three files exactly, in the layout the owner keeps', () => {
  const contents = { 'owner-signing-key.pem': '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n', '.env': 'APP_MODE=paper\r\nHOST=127.0.0.1\r\n',
    '.local/credentials.json': '[\n  {"role": "owner"}\n]' };
  const text = secretsBundle(contents);
  assert.match(text, /^owner-signing-key\.pem\n-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n\n\n\.env\nAPP_MODE=paper\nHOST=127\.0\.0\.1\n\n\n\.local\/credentials\.json\n\[/);
  const back = parseBundle(text);
  assert.equal(back['.env'], 'APP_MODE=paper\nHOST=127.0.0.1\n');                 // line endings normalised, nothing lost
  assert.equal(back['.local/credentials.json'], '[\n  {"role": "owner"}\n]\n');
  assert.equal(back['owner-signing-key.pem'], contents['owner-signing-key.pem']);
  assert.deepEqual(Object.keys(parseBundle('owner-signing-key.pem\nK\n\n\n.env\nA=1\n')), ['owner-signing-key.pem', '.env']);   // the owner's older file reads too
});
import { handedOver } from './supervisor.mjs';

test('the handover waits for a running job and knows a stale heartbeat from a live one', () => {
  const now = Date.parse('2026-10-28T12:00:00Z');
  assert.deepEqual(supervisorState({ at: '2026-10-28T11:59:30Z', pid: 7, running: 'cycle' }, now), { state: 'busy', pid: 7, running: 'cycle' });
  assert.deepEqual(supervisorState({ at: '2026-10-28T11:59:30Z', pid: 7, running: null }, now), { state: 'idle', pid: 7, running: null });
  assert.deepEqual(supervisorState({ at: '2026-10-28T11:40:00Z', pid: 7, running: 'cycle' }, now), { state: 'none' });   // it died mid-job
  assert.deepEqual(supervisorState(null, now), { state: 'none' });
});

test('a machine that handed over refuses to run the organisation until it takes it back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'org-handover-'));
  try {
    assert.equal(handedOver(dir), null);
    await mkdir(join(dir, '.local'), { recursive: true });
    await writeFile(join(dir, '.local', 'handover.json'), JSON.stringify({ at: '2026-10-28T13:00:00Z', to: 'home EliteBook' }));
    assert.match(handedOver(dir), /handed the organisation over to home EliteBook/);
    assert.equal(handedOver(dir, ['--take-back']), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
