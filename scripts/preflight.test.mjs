import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assess, gather, summary } from './preflight.mjs';

const NOW = Date.parse('2026-10-24T05:00:00Z'); // Saturday 10:30 IST
const READY = {
  settings: { present: true, roles: ['owner', 'researcher', 'evaluator', 'trader'], ruleBotCredential: true, modelKey: 'qwen3.5-4b-q4km',
    has: { OWNER_PUBLIC_KEY_BASE64: true, RULE_BOT_ID: true, MODEL_AUTOSTART: true, HERMES_MODEL_BASE_URL: true, ALERT_WEBHOOK_URL: true, TA_BOT_ID: false } },
  backendUp: false, newestMigration: '052_autonomy.sql', newestMigrationAt: NOW - 4 * 86_400_000, backupAt: NOW - 3_600_000, venv: true, taVenv: false,
  lastBar: '2026-10-23', model: { known: true, weights: true, runtime: true }, policyValid: true,
  holidays: { years: new Set([2026]), days: new Set() }, holidayDays: new Set(), supervisor: 'alive', worldFeeds: 9,
};
const status = (checks, id) => checks.find(c => c.id === id)?.status;

test('a fully prepared organisation is READY, with the starter policy still recommended', () => {
  const checks = assess(READY, NOW);
  assert.equal(summary(checks), 'READY (1 recommended)');
  assert.equal(status(checks, 'standing-approvals'), 'OPTIONAL');
});

test('each gap says what to do, and a backup older than the newest migration is a must', () => {
  assert.equal(status(assess({ ...READY, backupAt: NOW - 5 * 86_400_000 }, NOW), 'backup'), 'TODO');
  assert.match(assess({ ...READY, backupAt: NOW - 5 * 86_400_000 }, NOW).find(c => c.id === 'backup').detail, /older than the newest migration/);
  assert.equal(status(assess({ ...READY, backendUp: true }, NOW), 'backend'), 'TODO');
  assert.equal(status(assess({ ...READY, settings: { ...READY.settings, roles: ['owner'] } }, NOW), 'settings'), 'TODO');
  assert.equal(status(assess({ ...READY, settings: { ...READY.settings, ruleBotCredential: false } }, NOW), 'rule-bot'), 'TODO');
  const noModel = assess({ ...READY, settings: { ...READY.settings, has: { ...READY.settings.has, MODEL_AUTOSTART: false } } }, NOW);
  assert.equal(status(noModel, 'model'), 'OPTIONAL');
  assert.match(assess({ ...READY, model: { known: true, weights: false, runtime: true } }, NOW).find(c => c.id === 'model').detail, /weights are not downloaded/);
  assert.equal(status(assess({ ...READY, holidays: { years: new Set([2025]), days: new Set() } }, NOW), 'holidays'), 'TODO'); // not this year
  assert.equal(status(assess({ ...READY, supervisor: 'stale' }, NOW), 'supervisor'), 'OPTIONAL');
  assert.match(summary(assess({ ...READY, backendUp: true, venv: false }, NOW)), /^NOT READY: 2 thing\(s\) to do first/);
});

test('gather reads names and files only; no setting value appears in its facts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'preflight-'));
  try {
    await mkdir(join(root, 'db', 'migrations'), { recursive: true });
    await writeFile(join(root, 'db', 'migrations', '052_autonomy.sql'), '-- fixture');
    await mkdir(join(root, '.local', 'backups', 'backup-1'), { recursive: true });
    await writeFile(join(root, '.local', 'backups', 'backup-1', 'manifest.json'), '{}');
    await utimes(join(root, '.local', 'backups', 'backup-1', 'manifest.json'), new Date(NOW / 1000 - 86_400 * 9) , new Date((NOW - 9 * 86_400_000)));
    await writeFile(join(root, '.local', 'feed-a.json'), JSON.stringify({ enabled: true }));
    const env = { PRINCIPALS_JSON: JSON.stringify([{ role: 'owner', token: 'SECRET-TOKEN-VALUE' }, { role: 'trader', botId: 'momentum-rules', token: 't' }]),
      RULE_BOT_ID: 'momentum-rules', OWNER_PUBLIC_KEY_BASE64: 'SECRET-KEY-VALUE' };
    const facts = await gather(env, { root, fetchImpl: async () => { throw new Error('down'); }, now: NOW });
    assert.doesNotMatch(JSON.stringify(facts), /SECRET/);
    assert.deepEqual([facts.settings.roles, facts.settings.ruleBotCredential, facts.backendUp, facts.worldFeeds, facts.newestMigration],
      [['owner', 'trader'], true, false, 1, '052_autonomy.sql']);
    const checks = assess(facts, NOW);
    assert.equal(status(checks, 'backup'), 'TODO');
    assert.doesNotMatch(JSON.stringify(checks), /SECRET/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
