import assert from 'node:assert/strict';
import test from 'node:test';
import { serverArgs } from './local-model.mjs';

const SERVER = { host: '127.0.0.1', port: 8080, contextTokens: 16384, parallel: 1, reasoning: 'off' };

test('the server line is the lock settings; threads appear only once measured', () => {
  const plain = serverArgs(SERVER, 'w.gguf', 'Qwen');
  assert.deepEqual(plain.slice(0, 4), ['-m', 'w.gguf', '--alias', 'Qwen']);
  assert.ok(!plain.includes('-t') && !plain.includes('-tb'));                  // llama.cpp's own default until measured
  assert.ok(plain.includes('--no-webui') && plain[plain.indexOf('--reasoning') + 1] === 'off');
  const tuned = serverArgs({ ...SERVER, threads: 6, threadsBatch: 10 }, 'w.gguf', 'Qwen');
  assert.equal(tuned[tuned.indexOf('-t') + 1], '6');
  assert.equal(tuned[tuned.indexOf('-tb') + 1], '10');
  assert.ok(!tuned.some(a => /key/i.test(a)));                                 // the API key never travels on the command line
});
