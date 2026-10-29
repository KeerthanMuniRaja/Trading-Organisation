import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { leftBehind, parseBundle, preview, secretsBundle, supervisorState } from './handover.mjs';

test('--check says what the handover would find, and names code that would stay behind', () => {
  const now = Date.parse('2026-10-30T14:00:00Z'), all = [['.env', true], ['.local/credentials.json', true], ['.local/owner-signing-key.pem', true]];
  const busy = preview({ beat: { at: '2026-10-30T13:59:30Z', pid: 7, running: 'cycle' }, backendUp: true, secrets: all, porcelain: '', dataRepo: true, now });
  assert.deepEqual([busy.ready, busy.supervisor, busy.uncommittedCode], [true, 'busy with "cycle": the handover waits for it', []]);
  const messy = preview({ beat: null, backendUp: true, secrets: [...all.slice(0, 2), ['.local/owner-signing-key.pem', false]],
    porcelain: ' M scripts/x.mjs\r\n?? integrations/new.py\n', dataRepo: false, now });
  assert.equal(messy.ready, false);
  assert.deepEqual(messy.blockers, ['the backend runs without the supervisor: stop it first', 'missing .local/owner-signing-key.pem (the secret backup needs it)',
    'no data repository at .local/data-repo']);
  assert.deepEqual(messy.uncommittedCode, ['scripts/x.mjs', 'integrations/new.py']);
  assert.match(messy.warning, /2 uncommitted code change\(s\) would stay on this machine/);
  assert.deepEqual(leftBehind(''), []);
});

test('the secret backup restores the three files exactly, in the layout the owner keeps', () => {
  // a fake key, its header assembled at run time so the secret scan never sees a key-shaped literal in the repository
  const pem = kind => `-----${kind} ${'PRIVATE'} KEY-----`;
  const fakeKey = `${pem('BEGIN')}\nabc\n${pem('END')}\n`;
  const contents = { 'owner-signing-key.pem': fakeKey, '.env': 'APP_MODE=paper\r\nHOST=127.0.0.1\r\n',
    '.local/credentials.json': '[\n  {"role": "owner"}\n]' };
  const text = secretsBundle(contents);
  assert.ok(text.startsWith(`owner-signing-key.pem\n${fakeKey}\n\n.env\nAPP_MODE=paper\nHOST=127.0.0.1\n\n\n.local/credentials.json\n[`));
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
