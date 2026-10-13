import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scan, scanText } from './secret-scan.mjs';

const fake = (prefix, n) => prefix + 'A1b2C3d4E5'.repeat(Math.ceil(n / 10)).slice(0, n);

test('credential patterns are found and reported without the secret itself', () => {
  const lines = [
    '-----BEGIN PRIVATE KEY-----',
    `const t = "${fake('ghp_', 36)}";`,
    `key: ${fake('sk-ant-', 40)}`,
    `PRINCIPALS_JSON='[{"id":"owner","role":"owner","token":"${fake('', 48)}"}]'`,
    `password = "${fake('', 40)}"`,
    'const harmless = "token budget per day";',
  ].join('\n');
  const findings = scanText('backend/src/x.ts', lines);
  assert.deepEqual(findings.map(f => f.rule), ['private-key', 'github-token', 'anthropic-or-openai-key', 'principals-with-token', 'assigned-secret']);
  assert.ok(findings.every(f => !JSON.stringify(f).includes('A1b2C3d4E5'))); // the value is never echoed
  // test code may assign generated fake credentials, but real key and token formats are flagged everywhere
  assert.deepEqual(scanText('backend/test/helpers.ts', lines).map(f => f.rule), ['private-key', 'github-token', 'anthropic-or-openai-key']);
});

test('forbidden paths are flagged even when their content looks harmless', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scan-'));
  try {
    await mkdir(join(dir, '.local'), { recursive: true });
    await writeFile(join(dir, '.env'), 'APP_MODE=paper\n');
    await writeFile(join(dir, '.local', 'notes.md'), 'nothing secret\n');
    await writeFile(join(dir, 'owner-signing-key.pem'), 'x\n');
    await writeFile(join(dir, 'ok.md'), 'Plain documentation.\n');
    await writeFile(join(dir, '.env.example'), 'APP_MODE=paper\n');
    const findings = await scan(dir, ['.env', '.local/notes.md', 'owner-signing-key.pem', 'ok.md', '.env.example']);
    assert.deepEqual(findings.map(f => [f.path, f.rule]), [['.env', 'forbidden-path'], ['.local/notes.md', 'forbidden-path'],
      ['owner-signing-key.pem', 'forbidden-path']]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
