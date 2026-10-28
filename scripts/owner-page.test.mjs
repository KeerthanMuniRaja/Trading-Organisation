import assert from 'node:assert/strict';
import test from 'node:test';
import { html, toTiles } from './owner-page.mjs';

const LINES = ['Organisation status, 2026-10-28 12:00 UTC (paper only)', '',
  'Backend   up    Model up', 'Agenda    1 decision(s) waiting (npm run agenda)', '',
  'Members', '  momentum-rules   paper; release v3 canary', '  trend-bot        paper; no release (shadow)', '',
  'Money     realised Rs 44.24', 'Cycle     2026-10-28: no failed steps', 'Supervisor STUCK: news was due at 07:00 UTC',
  'Regime    SEVERE on 2026-10-28', 'Pulse     7d: 8 up, 10 down', 'Forward   m12: waiting', 'Models    tuned 2026-10-31: CPU',
  '', 'Needs you', '  - warning: 42 pieces of evidence have waited', '  - <script>alert(1)</script>'];

test('the status lines become tiles, members and needs under their headings', () => {
  const tiles = Object.fromEntries(toTiles(LINES));
  assert.deepEqual(tiles['Needs you'].map(i => i.label), ['Needs you', 'Needs you', 'Agenda']);
  assert.deepEqual(tiles['Members and money'].map(i => i.text), ['momentum-rules   paper; release v3 canary', 'trend-bot        paper; no release (shadow)', 'realised Rs 44.24']);
  assert.ok(tiles['Organisation'].some(i => i.label === 'Supervisor' && /STUCK/.test(i.text)));
  assert.deepEqual(tiles['Market'].map(i => i.label), ['Regime', 'Pulse']);
  assert.deepEqual(tiles['Models'].map(i => i.text), ['tuned 2026-10-31: CPU']);
});

test('the page is self-contained, view-only, escaped, and marks alarms', () => {
  const page = html(toTiles(LINES), LINES[0], '2026-10-28 12:00 UTC');
  assert.ok(!/<script[\s>]/i.test(page.replace(/&lt;script&gt;/g, '')));        // nothing from the data ever runs
  assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(page, /<li class="alarm"><span class="label">Supervisor<\/span> STUCK/);
  assert.match(page, /prefers-color-scheme: dark/);
  assert.ok(!/<(form|button|input)\b/i.test(page) && !/https?:\/\/(?!www\.w3)/.test(page));   // no actions, no external loads
});
