import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { supervisorState } from './handover.mjs';
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
