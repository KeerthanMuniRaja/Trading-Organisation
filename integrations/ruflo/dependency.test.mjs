import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
test('pinned TOML override preserves parsing and rejects excessive recursion', () => {
  const toml = require('toml');
  assert.equal(require('toml/package.json').version,'4.2.0');
  const config = toml.parse('[research]\nenabled = true\nlimit = 25\n');
  assert.equal(config.research.enabled,true);
  assert.equal(config.research.limit,25);
  assert.throws(()=>toml.parse('a='+'['.repeat(3000)+'1'+']'.repeat(3000)),error=>!(error instanceof RangeError));
  assert.equal(Object.prototype.polluted,undefined);
});
