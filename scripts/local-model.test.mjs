import assert from 'node:assert/strict';
import test from 'node:test';
import { machineServer, pickCandidate, pinFromRelease, pinFromTree, serverArgs } from './local-model.mjs';

const HASH = 'a'.repeat(64);

test('an artifact outside the lock is accepted only with the hash its official source publishes', () => {
  const release = { tag_name: 'b11435', assets: [{ name: 'llama-vulkan.zip', size: 50, browser_download_url: 'https://github.com/x.zip', digest: 'sha256:' + HASH }] };
  assert.deepEqual(pinFromRelease(release, 'llama-vulkan.zip'), { file: 'llama-vulkan.zip', url: 'https://github.com/x.zip', sha256: HASH, bytes: 50, source: 'github-release-digest' });
  assert.throws(() => pinFromRelease({ assets: [{ name: 'llama-vulkan.zip', size: 50 }] }, 'llama-vulkan.zip'), /no published sha256/);
  assert.throws(() => pinFromRelease(release, 'other.zip'), /has no other.zip/);
  const tree = [{ path: 'M-Q4_K_M.gguf', lfs: { oid: HASH, size: 9 } }, { path: 'README.md' }];
  const pin = pinFromTree('org/M-GGUF', 'c0ffee', tree, 'M-Q4_K_M.gguf');
  assert.equal(pin.url, 'https://huggingface.co/org/M-GGUF/resolve/c0ffee/M-Q4_K_M.gguf');   // an exact commit, never "main"
  assert.equal(pin.sha256, HASH);
  assert.throws(() => pinFromTree('org/M-GGUF', 'c0ffee', tree, 'README.md'), /no LFS hash/);
});

test('the decision model is the largest candidate the RAM fits; tuning and the decision port reach the server', () => {
  const c = [{ key: '14b', minRamGB: 28 }, { key: '9b', minRamGB: 15 }];
  assert.deepEqual(pickCandidate(c, 15.7 * 2 ** 30).map(x => x.key), ['9b']);          // this office laptop's 15.7 GB
  assert.deepEqual(pickCandidate(c, 32 * 2 ** 30).map(x => x.key), ['14b', '9b']);
  assert.deepEqual(pickCandidate(c, 8 * 2 ** 30), []);
  const lockServer = { host: '127.0.0.1', port: 8080, contextTokens: 16384, parallel: 1, reasoning: 'off' };
  const tuned = machineServer(lockServer, { runtime: 'vulkan', threads: 4, threadsBatch: 8, gpuLayers: 99 }, { decision: true, vulkanInstalled: true });
  assert.deepEqual([tuned.runtime, tuned.settings.port, tuned.settings.threads, tuned.settings.gpuLayers], ['vulkan', 8081, 4, 99]);
  const noVulkan = machineServer(lockServer, { runtime: 'vulkan', threads: 4, gpuLayers: 99 }, { vulkanInstalled: false });
  assert.deepEqual([noVulkan.runtime, noVulkan.settings.port, noVulkan.settings.gpuLayers], ['cpu', 8080, undefined]);   // never GPU layers on the CPU build
  assert.equal(machineServer(lockServer, null).settings.threads, undefined);
});

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
