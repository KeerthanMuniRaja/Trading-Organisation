import assert from 'node:assert/strict';
import test from 'node:test';
import { best, candidates, choose } from './model-tune.mjs';

const row = (t, pp, tg, ts) => ({ n_threads: t, n_prompt: pp, n_gen: tg, avg_ts: ts });

test('thread counts to try fit the machine', () => {
  assert.deepEqual(candidates(12), [2, 4, 6, 8, 10, 12]);
  assert.deepEqual(candidates(4), [2, 4]);
});

test('the fastest typical call wins: prompt and generation threads chosen separately', () => {
  const b = best([row(4, 512, 0, 30), row(8, 512, 0, 45), row(4, 0, 64, 6), row(8, 0, 64, 4.5)]);
  assert.deepEqual([b.threads, b.threadsBatch], [4, 8]);                           // generation likes fewer, prompt more
  assert.equal(b.secondsPerCall, Math.round((600 / 45 + 150 / 6) * 10) / 10);
  assert.equal(best([row(4, 512, 0, 30)]), null);                                  // a half-measured run is not used
});

test('the graphics build is chosen only when clearly faster', () => {
  const cpu = { secondsPerCall: 40 };
  assert.equal(choose(cpu, { secondsPerCall: 38 }).runtime, 'cpu');               // within 10%: the simpler CPU build
  assert.deepEqual(choose(cpu, { secondsPerCall: 20 }), { runtime: 'vulkan', gpuLayers: 99, secondsPerCall: 20 });
  assert.equal(choose(null, null), null);
  assert.equal(choose(cpu, null).runtime, 'cpu');
});
