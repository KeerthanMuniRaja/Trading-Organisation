import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deliver, settings } from './deliver-alerts.mjs';

const principals = JSON.stringify([{ id: 'owner', role: 'owner', token: 'o'.repeat(43) }, { id: 'evaluator', role: 'evaluator', token: 'e'.repeat(43) }]);
const alerts = [
  { id: 'a1', severity: 'critical', rule: 'system-halted', subject: 'organisation', message: 'New risk is halted.', raisedAt: '2026-10-13T10:00:00Z' },
  { id: 'a2', severity: 'warning', rule: 'bot-drawdown', subject: 'bot-one', message: 'Fell 15%.', raisedAt: '2026-10-13T10:00:00Z' }];

function fakeBackend({ webhookFailsFor = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null, auth: init.headers.Authorization });
    const json = body => ({ ok: true, status: 200, json: async () => body });
    if (url.endsWith('/v1/alerts/cycles')) return json({ raised: alerts, resolved: 0, open: 2 });
    if (url.endsWith('/v1/alerts/query')) return json({ alerts, undelivered: ['a1', 'a2'] });
    if (url.endsWith('/v1/alerts/deliveries')) return json({ delivered: JSON.parse(init.body).alertIds.length });
    if (url.startsWith('https://notify.example')) {
      const failing = webhookFailsFor && JSON.parse(init.body).id === webhookFailsFor;
      return { ok: !failing, status: failing ? 502 : 200 };
    }
    throw new Error('unexpected ' + url);
  };
  return { calls, fetchImpl };
}

test('alerts go to the outbox and are marked delivered with the evaluator credential', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'alerts-'));
  try {
    const backend = fakeBackend();
    const result = await deliver({ PRINCIPALS_JSON: principals, ALERT_OUTBOX: join(dir, 'outbox.jsonl') }, { fetchImpl: backend.fetchImpl });
    assert.deepEqual([result.delivered, result.failed, result.channel], [2, 0, 'outbox']);
    const lines = (await readFile(join(dir, 'outbox.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(lines.map(l => l.rule), ['system-halted', 'bot-drawdown']);
    assert.ok(backend.calls.every(c => c.url.startsWith('https://') || c.auth === 'Bearer ' + 'e'.repeat(43)));
    assert.deepEqual(backend.calls.at(-1).body, { alertIds: ['a1', 'a2'] });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a failed webhook leaves that alert undelivered for the next run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'alerts-'));
  try {
    const backend = fakeBackend({ webhookFailsFor: 'a2' });
    const result = await deliver({ PRINCIPALS_JSON: principals, ALERT_OUTBOX: join(dir, 'o.jsonl'), ALERT_WEBHOOK_URL: 'https://notify.example/topic' },
      { fetchImpl: backend.fetchImpl });
    assert.deepEqual([result.delivered, result.failed, result.channel], [1, 1, 'outbox+webhook']);
    assert.deepEqual(backend.calls.at(-1).body, { alertIds: ['a1'] });
    assert.ok(!backend.calls.some(c => c.url.startsWith('https://notify') && c.auth)); // the backend credential never goes to the webhook
    // the retry next run tries the webhook again, but the outbox keeps one line per alert
    const again = fakeBackend({ webhookFailsFor: 'a2' });
    await deliver({ PRINCIPALS_JSON: principals, ALERT_OUTBOX: join(dir, 'o.jsonl'), ALERT_WEBHOOK_URL: 'https://notify.example/topic' }, { fetchImpl: again.fetchImpl });
    const ids = (await readFile(join(dir, 'o.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l).id);
    assert.equal(ids.filter(i => i === 'a2').length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('unsafe configuration is refused', () => {
  assert.throws(() => settings({ PRINCIPALS_JSON: principals, ALERT_WEBHOOK_URL: 'http://notify.example/x' }), /HTTPS/);
  assert.throws(() => settings({ PRINCIPALS_JSON: principals, ALERT_WEBHOOK_URL: 'https://user:pw@notify.example/x' }), /credentials/);
  assert.throws(() => settings({ PRINCIPALS_JSON: principals, API_URL: 'http://evil.example' }), /origin/);
  assert.throws(() => settings({ PRINCIPALS_JSON: '[]' }), /evaluator/);
});
