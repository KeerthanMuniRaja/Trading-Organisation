import test from 'node:test';
import assert from 'node:assert/strict';
import { childEnv, commands, indiaDay, modelHealthUrl, nextRuns } from './supervisor.mjs';

const ist = s => Date.parse(s + '+05:30');

test('jobs run on trading days only, at their India times; holidays come from the owner calendar', () => {
  const tuesdayNoon = ist('2026-10-20T12:00:00');
  assert.deepEqual(nextRuns(tuesdayNoon).map(r => [r.id, r.day]), [['cycle', '2026-10-20'], ['readiness', '2026-10-21'], ['backup', '2026-10-23']]);
  assert.equal(new Date(nextRuns(tuesdayNoon)[0].at).toISOString(), '2026-10-20T10:35:00.000Z'); // 16:05 IST
  const fridayEvening = ist('2026-10-23T17:00:00');
  assert.deepEqual(nextRuns(fridayEvening).map(r => [r.id, r.day]), [['readiness', '2026-10-26'], ['cycle', '2026-10-26'], ['backup', '2026-10-30']]); // weekend skipped
  const holiday = new Set(['2026-10-26']); // a fixture date, not the real calendar
  assert.equal(nextRuns(fridayEvening, holiday)[0].day, '2026-10-27');
  assert.deepEqual(indiaDay(Date.parse('2026-10-20T20:00:00Z')), { day: '2026-10-21', weekday: 3 }); // 01:30 IST is already Wednesday
});

test('each job starts the backend only when it is down, uses the model only when it answers, and backs up a closed database', () => {
  const ids = (job, s) => commands(job, s).map(c => c.id);
  assert.deepEqual(ids('cycle', { backendUp: true, modelUp: false }), ['cycle']);
  assert.deepEqual(ids('cycle', { backendUp: false, modelUp: false }), ['start-backend', 'cycle', 'stop-backend']); // left as it was found
  assert.deepEqual(commands('cycle', { backendUp: true, modelUp: true })[0].args, ['run', 'cycle', '--', '--with-model']);
  const running = commands('backup', { backendUp: true, modelUp: false });
  assert.deepEqual([running.length, running[0].id, /not started by the supervisor/.test(running[0].skip)], [1, 'backup', true]); // never stops someone else's backend
  assert.deepEqual(commands('backup', { backendUp: false, modelUp: false }).map(c => [c.id, c.args.join(' ')]), [['backup', 'run backup -- create']]);
  const start = commands('cycle', { backendUp: false, modelUp: false })[0];
  assert.deepEqual([start.cmd, start.args[0], start.background], [process.execPath, '--env-file=.env', true]); // its real pid, no shell
  assert.deepEqual(ids('readiness', { backendUp: false, modelUp: false }), ['start-backend', 'readiness', 'stop-backend']);
  assert.throws(() => commands('trade', { backendUp: true }), /Unknown job/);
});

test('the model is started for a cycle only when the owner named one, and stopped afterwards; health is the public endpoint', () => {
  const ids = s => commands('cycle', s).map(c => c.id);
  assert.deepEqual(ids({ backendUp: true, modelUp: false, modelAuto: 'qwen3.5-4b' }), ['start-model', 'cycle', 'stop-model']);
  assert.deepEqual(commands('cycle', { backendUp: true, modelUp: false, modelAuto: 'qwen3.5-4b' })[1].args, ['run', 'cycle', '--', '--with-model']);
  assert.deepEqual(commands('cycle', { backendUp: true, modelUp: false, modelAuto: 'qwen3.5-4b' })[0].args.slice(-2), ['serve', 'qwen3.5-4b']);
  assert.deepEqual(ids({ backendUp: true, modelUp: true, modelAuto: 'qwen3.5-4b' }), ['cycle']); // already running: used, not restarted or stopped
  assert.deepEqual(ids({ backendUp: true, modelUp: false }), ['cycle']); // not named: no model, no model steps
  assert.deepEqual(ids({ backendUp: false, modelUp: false, modelAuto: 'm' }), ['start-backend', 'start-model', 'cycle', 'stop-model', 'stop-backend']);
  assert.equal(modelHealthUrl('http://127.0.0.1:8080/v1'), 'http://127.0.0.1:8080/health');
  assert.equal(modelHealthUrl('http://127.0.0.1:8080/v1/'), 'http://127.0.0.1:8080/health');
  assert.equal(modelHealthUrl(undefined), null);
});

test('children never inherit settings that would override .env', () => {
  const env = childEnv({ PATH: 'p', MAX_ORDER_PAISE: '100000', PRINCIPALS_JSON: '[old]', DATABASE_PATH: 'x', HERMES_MODEL: 'm' });
  assert.deepEqual(env, { PATH: 'p', HERMES_MODEL: 'm' });
});
