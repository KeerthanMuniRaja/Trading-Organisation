import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { anotherRunning, watchdogDue, needsShell, MAX_ATTEMPTS, catchUp, childEnv, commands, heartbeat, history, indiaDay, modelHealthUrl, nextNews, nextRuns, newsMinutes, NEWS_MINUTES } from './supervisor.mjs';
import { enabledFeeds } from './organisation-cycle.mjs';

test('news is polled on the clock every day, weekends and nights included, with the backend up only while it polls', async () => {
  const saturdayNight = Date.parse('2026-10-24T17:40:00Z'); // 23:10 IST on a Saturday: no daily job, but news still flows
  const n = nextNews(saturdayNight);
  assert.equal(new Date(n.at).toISOString(), '2026-10-24T18:00:00.000Z'); // the next half hour on the clock
  assert.equal(nextNews(saturdayNight, 0), null);
  assert.deepEqual([newsMinutes({}), newsMinutes({ SUPERVISOR_NEWS_MINUTES: '0' }), newsMinutes({ SUPERVISOR_NEWS_MINUTES: '60' }),
    newsMinutes({ SUPERVISOR_NEWS_MINUTES: '5' })], [NEWS_MINUTES, 0, 60, NEWS_MINUTES]); // too frequent is not allowed
  const feeds = ['feed-livemint.json', 'feed-us-fed.json'];
  assert.deepEqual(commands('news', { backendUp: false, modelUp: false, feeds }).map(c => c.id), ['start-backend', 'news-livemint', 'news-us-fed', 'stop-backend']);
  assert.deepEqual(commands('news', { backendUp: true, modelUp: false, feeds }).map(c => c.id), ['news-livemint', 'news-us-fed']);
  const poll = commands('news', { backendUp: true, modelUp: false, feeds })[0];
  assert.deepEqual(poll.args.slice(-3).map(a => a.split(/[\\/]/).join('/')), ['run', '.local/feed-livemint.json', '.local/feeds/livemint']);
  assert.match(commands('news', { backendUp: false, modelUp: false, feeds: [] })[0].skip, /no feed is enabled/); // nothing to start the backend for
  // only configurations the owner enabled are polled
  const root = await mkdtemp(join(tmpdir(), 'feeds-'));
  try {
    await mkdir(join(root, '.local'), { recursive: true });
    await writeFile(join(root, '.local', 'feed-on.json'), JSON.stringify({ enabled: true }));
    await writeFile(join(root, '.local', 'feed-off.json'), JSON.stringify({ enabled: false }));
    await writeFile(join(root, '.local', 'feed-broken.json'), '{');
    assert.deepEqual(await enabledFeeds(root), ['feed-on.json']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('started late, it catches up today\'s jobs that still help, at most twice each, and never on a holiday', () => {
  const day = '2026-10-21';
  assert.deepEqual(catchUp(ist(`${day}T08:30:00`), new Set(), new Set()), []);                  // nothing is due yet
  assert.deepEqual(catchUp(ist(`${day}T10:00:00`), new Set(), new Set()), ['readiness']);       // missed 09:00, the session is still open
  assert.deepEqual(catchUp(ist(`${day}T15:45:00`), new Set(), new Set()), []);                  // readiness is pointless after the close
  assert.deepEqual(catchUp(ist(`${day}T17:30:00`), new Set(), new Set()), ['cycle']);           // slept through 16:05
  assert.deepEqual(catchUp(ist(`${day}T17:30:00`), new Set(), new Set([`cycle:${day}`])), []);  // already ran (also by hand)
  assert.deepEqual(catchUp(ist(`${day}T17:30:00`), new Set(), new Set(), new Map([[`cycle:${day}`, MAX_ATTEMPTS]])), []); // a broken setup is not retried forever
  assert.deepEqual(catchUp(ist(`${day}T17:30:00`), new Set([day]), new Set()), []);             // a holiday
  assert.deepEqual(catchUp(ist('2026-10-24T17:30:00'), new Set(), new Set()), []);              // Saturday
});

test('history reads the supervisor log and the cycle journal; the heartbeat says alive, stale or never', async () => {
  const root = await mkdtemp(join(tmpdir(), 'supervisor-'));
  try {
    assert.equal((await heartbeat(root)).state, 'never');
    await mkdir(join(root, '.local', 'supervisor'), { recursive: true });
    await mkdir(join(root, '.local', 'cycles'), { recursive: true });
    const lines = [{ job: 'readiness', step: 'start' }, { job: 'readiness', step: 'readiness', ok: true }, { job: 'cycle', step: 'start' },
      { job: 'cycle', step: 'start-backend', ok: false }, { job: 'supervisor', step: 'waiting' }];
    await writeFile(join(root, '.local', 'supervisor', '2026-10-21.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\nnot json\n');
    let h = await history('2026-10-21', root);
    assert.deepEqual([...h.done], ['readiness:2026-10-21']);
    assert.equal(h.attempts.get('cycle:2026-10-21'), 1);                    // started once, never reached its main step
    await writeFile(join(root, '.local', 'cycles', '2026-10-21.json'), JSON.stringify({ finishedAt: '2026-10-21T11:00:00Z', steps: {} }));
    h = await history('2026-10-21', root);
    assert.ok(h.done.has('cycle:2026-10-21'));                              // the owner ran it by hand
    const at = Date.parse('2026-10-21T11:00:00Z');
    await writeFile(join(root, '.local', 'supervisor', 'heartbeat.json'), JSON.stringify({ at: new Date(at).toISOString(), running: 'cycle', next: 'readiness' }));
    const alive = await heartbeat(root, at + 60_000);
    assert.deepEqual([alive.state, alive.running], ['alive', 'cycle']);
    assert.equal((await heartbeat(root, at + 10 * 60_000)).state, 'stale');
    // beating but not scheduling: a job long overdue with nothing running is 'stuck', not 'alive'
    const due = new Date(at - 30 * 60_000).toISOString();
    await writeFile(join(root, '.local', 'supervisor', 'heartbeat.json'), JSON.stringify({ at: new Date(at).toISOString(), running: null, next: 'news', nextAt: due }));
    assert.equal((await heartbeat(root, at + 60_000)).state, 'stuck');
    await writeFile(join(root, '.local', 'supervisor', 'heartbeat.json'), JSON.stringify({ at: new Date(at).toISOString(), running: null, next: 'news', nextAt: new Date(at + 60_000).toISOString() }));
    assert.equal((await heartbeat(root, at + 30_000)).state, 'alive');                // due soon: fine
  } finally { await rm(root, { recursive: true, force: true }); }
});

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

test('one supervisor at a time, and a stuck one is replaced rather than left lying', () => {
  const now = Date.parse('2026-10-28T12:00:00Z');
  const live = { at: '2026-10-28T11:59:30Z', pid: 7, running: null, next: 'news', nextAt: '2026-10-28T12:30:00Z' };
  const yes = () => true, no = () => false;
  assert.equal(anotherRunning(live, { now, self: 9, exists: yes }), 7);                                   // healthy: do not start a second
  assert.equal(anotherRunning(live, { now, self: 7, exists: yes }), null);                                // it is me
  assert.equal(anotherRunning(live, { now, self: 9, exists: no }), null);                                 // its process is gone
  assert.equal(anotherRunning({ ...live, at: '2026-10-28T11:40:00Z' }, { now, self: 9, exists: yes }), null);   // stale heartbeat
  assert.equal(anotherRunning({ ...live, nextAt: '2026-10-28T11:30:00Z' }, { now, self: 9, exists: yes }), null);  // stuck: a replacement may start
  assert.equal(anotherRunning(null, { now, self: 9, exists: yes }), null);
  assert.equal(watchdogDue({ running: null, nextAt: '2026-10-28T11:45:00Z' }, now), true);                // 15 minutes overdue, nothing running
  assert.equal(watchdogDue({ running: null, nextAt: '2026-10-28T11:55:00Z' }, now), false);               // within the grace
  assert.equal(watchdogDue({ running: 'cycle', nextAt: '2026-10-28T10:00:00Z' }, now), false);           // a long cycle is not stuck
});

test('only npm gets a shell on Windows: a node path with a space must not be split', () => {
  const feed = commands('news', { backendUp: true, feeds: ['feed-wire.json'] })[0];
  assert.equal(needsShell(feed, 'win32'), false);                                  // 'C:\Program Files\nodejs\node.exe' ran through cmd broke
  assert.equal(needsShell(commands('cycle', { backendUp: true, modelUp: true })[0], 'win32'), true);   // npm.cmd needs it
  assert.equal(needsShell({ cmd: 'npm.cmd', background: true }, 'win32'), false);
  assert.equal(needsShell({ cmd: 'npm' }, 'linux'), false);
});

test('the model is started for a cycle only when the owner named one, and stopped afterwards; health is the public endpoint', () => {
  const ids = s => commands('cycle', s).map(c => c.id);
  assert.deepEqual(ids({ backendUp: true, modelUp: false, modelAuto: 'qwen3.5-4b' }), ['start-model', 'cycle', 'stop-model']);
  assert.deepEqual(commands('cycle', { backendUp: true, modelUp: false, modelAuto: 'qwen3.5-4b' })[1].args, ['run', 'cycle', '--', '--with-model']);
  assert.deepEqual(commands('cycle', { backendUp: true, modelUp: false, modelAuto: 'qwen3.5-4b' })[0].args.slice(-2), ['serve', 'qwen3.5-4b']);
  assert.deepEqual(ids({ backendUp: true, modelUp: true, modelAuto: 'qwen3.5-4b' }), ['cycle']); // already running: used, not restarted or stopped
  assert.deepEqual(ids({ backendUp: true, modelUp: false }), ['cycle']); // not named: no model, no model steps
  assert.deepEqual(ids({ backendUp: false, modelUp: false, modelAuto: 'm' }), ['start-backend', 'start-model', 'cycle', 'stop-model', 'stop-backend']);
  // MODEL-UPGRADE-01: a decision model that passed the exams is started too, optionally, and stopped with the other
  const withDecision = commands('cycle', { backendUp: true, modelUp: false, modelAuto: 'm', decisionHealth: 'http://127.0.0.1:8081/health' });
  assert.deepEqual(withDecision.map(c => c.id), ['start-model', 'start-decision-model', 'cycle', 'stop-model']);
  assert.deepEqual([withDecision[1].optional, withDecision[1].health, withDecision[1].args.slice(-2)], [true, 'http://127.0.0.1:8081/health', ['serve', 'decision']]);
  assert.deepEqual(ids({ backendUp: true, modelUp: false, decisionHealth: 'http://127.0.0.1:8081/health' }), ['cycle']);   // no model steps: no decision model
  assert.equal(modelHealthUrl('http://127.0.0.1:8080/v1'), 'http://127.0.0.1:8080/health');
  assert.equal(modelHealthUrl('http://127.0.0.1:8080/v1/'), 'http://127.0.0.1:8080/health');
  assert.equal(modelHealthUrl(undefined), null);
});

test('children never inherit settings that would override .env', () => {
  const env = childEnv({ PATH: 'p', MAX_ORDER_PAISE: '100000', PRINCIPALS_JSON: '[old]', DATABASE_PATH: 'x', HERMES_MODEL: 'm' });
  assert.deepEqual(env, { PATH: 'p', HERMES_MODEL: 'm' });
});
