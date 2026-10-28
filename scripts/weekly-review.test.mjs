import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gather, render, section, weekDays } from './weekly-review.mjs';

test('the trading week is Monday to Friday of the given day', () => {
  assert.deepEqual(weekDays('2026-10-28'), ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30']);
  assert.deepEqual(weekDays('2026-11-01'), ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30']);   // a Sunday: the week just ended
});

test('a digest section is read by its heading', () => {
  const md = '# Digest\n\n## Money (paper)\n- Total P&L Rs -141\n\n## Trading\n- 0 proposed\n';
  assert.equal(section(md, 'Money (paper)'), '- Total P&L Rs -141');
  assert.equal(section(md, 'Nothing'), null);
});

test('the week on one page: cycles, money, predictions, news, the model and what waits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'org-weekly-'));
  try {
    for (const d of ['cycles', 'digests', 'claims/auto', 'trading-desk/scenario', 'model-eval']) await mkdir(join(root, '.local', d), { recursive: true });
    await writeFile(join(root, '.local', 'cycles', '2026-10-27.json'), JSON.stringify({ startedAt: '2026-10-27T10:35:00Z', finishedAt: '2026-10-27T11:32:00Z',
      steps: { a: { status: 'done' }, 'rnd-scout': { status: 'failed' } } }));
    await writeFile(join(root, '.local', 'cycles', '2026-10-28.json'), JSON.stringify({ startedAt: '2026-10-28T10:36:00Z', finishedAt: '2026-10-28T11:32:00Z', steps: { a: { status: 'done' } } }));
    await writeFile(join(root, '.local', 'digests', '2026-10-28.md'), '## Money (paper)\n- Total P&L Rs -141.55\n\n## Against holding all shares equally (same days)\n- momentum-rules behind by 1 points\n');
    await writeFile(join(root, '.local', 'claims', 'auto', 'cycles.jsonl'), JSON.stringify({ at: '2026-10-28T10:45:00Z',
      steps: { 'analyst-extract': { callsThisRun: 80, accepted: 36 }, 'factcheck-evidence': { corroborated: 2 }, 'factcheck-lessons': { headlines: 2 } } }) + '\n');
    await writeFile(join(root, '.local', 'trading-desk', 'scenario', 'record.json'), JSON.stringify({ waiting: 2, panel: { right: 0, wrong: 0, verdict: 'insufficient-evidence' } }));
    await writeFile(join(root, '.local', 'model-eval', 'auto-last.json'), JSON.stringify({ tasks: ['debate', 'scenario'], overall: 'SHIP', at: '2026-10-29T12:00:00Z', model: 'Qwen3.5-4B' }));
    const page = render(await gather(weekDays('2026-10-28'), root));
    assert.match(page, /- 2026-10-26: did not run/);
    assert.match(page, /- 2026-10-27: finished, 2 steps, 57 min; failed: rnd-scout/);
    assert.match(page, /- 2 of 5 trading days ran/);
    assert.match(page, /## Money \(paper\), from the 2026-10-28 digest\n- Total P&L Rs -141.55/);
    assert.match(page, /behind by 1 points/);
    assert.match(page, /Scenario panel: 0 right, 0 wrong \(insufficient-evidence\); 2 call\(s\) waiting/);
    assert.match(page, /items read by the model: 80; claims accepted: 36; corroborated: 2; verified headlines now: 2/);
    assert.match(page, /Exams \(debate, scenario\): SHIP on 2026-10-29/);
    assert.match(page, /founderReview\.md/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
