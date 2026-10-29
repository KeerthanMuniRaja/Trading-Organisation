// Secret scan (SEC-01): checks every file git would publish (tracked plus untracked, not ignored) for credentials,
// private keys and forbidden paths before a push. Exits non-zero on any finding; prints file:line and the rule, never
// the matched secret itself.
//   node scripts/secret-scan.mjs
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RULES = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['github-token', /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/],
  // not glued to a '-' or '/' before it: "/markets/sk-hynix-shares-..." is a news address (SK Hynix), not a key
  ['anthropic-or-openai-key', /(?<![-/])\bsk-(ant-)?[A-Za-z0-9_-]{30,}\b/],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['slack-token', /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/],
  ['principals-with-token', /PRINCIPALS_JSON\s*=\s*['"]?\[\s*\{[^\n]*"token"\s*:\s*"[A-Za-z0-9_-]{40,}"/],
  ['assigned-secret', /\b(api[_-]?key|secret|password|passwd|token)\b\s*[:=]\s*['"][A-Za-z0-9+/_-]{32,}['"]/i],
  // JSON keeps the key in quotes ("token": "..."), which the rule above does not see
  ['json-secret', /"(api[_-]?key|apiKey|secret|password|token|accessToken)"\s*:\s*"[A-Za-z0-9+/_.-]{32,}"/i],
];
export const FORBIDDEN_PATHS = [/^\.env$/, /^\.env\.(?!example$)/, /(^|\/)\.local\//, /(^|\/)\.data\//, /owner-signing-key/, /credentials\.json$/, /\.pem$/];
// Test code builds fake credentials on purpose, so only the loose heuristics are relaxed there; real key and token
// formats are flagged everywhere. The scanner's own source holds the patterns, not secrets.
const TEST_PATH = /(^|\/)test\/|\.test\.(mjs|ts)$|(^|\/)test_[^/]+\.py$/;
const RELAXED_IN_TESTS = new Set(['assigned-secret', 'principals-with-token', 'json-secret']);
const SELF = /(^|\/)scripts\/secret-scan(\.test)?\.mjs$/;
const TEXT = /\.(m?js|ts|py|jsonl?|md|sql|ya?ml|txt|toml|cfg|ini|sh|ps1|cmd|html|css|env|log|xml|csv)$|^Dockerfile$|^\.[a-z]+ignore$/i;

export function scanText(path, text) {
  const findings = [];
  if (SELF.test(path)) return findings;
  const testCode = TEST_PATH.test(path);
  text.split(/\r?\n/).forEach((line, index) => {
    for (const [rule, pattern] of RULES)
      if (!(testCode && RELAXED_IN_TESTS.has(rule)) && pattern.test(line)) findings.push({ path, line: index + 1, rule });
  });
  return findings;
}

export function publishable(root = '.') {
  const out = execFileSync('git', ['-c', 'safe.directory=*', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  return out.toString('utf8').split('\0').filter(Boolean).map(p => p.replace(/\\/g, '/'));
}

export async function scan(root = '.', files = publishable(root)) {
  const findings = [];
  for (const path of files) {
    if (FORBIDDEN_PATHS.some(p => p.test(path))) { findings.push({ path, line: 0, rule: 'forbidden-path' }); continue; }
    const name = path.split('/').pop();
    if (!TEXT.test(name) || path.includes('node_modules/')) continue;
    let text;
    try { text = await readFile(resolve(root, path), 'utf8'); } catch { continue; }
    if (text.length > 5_000_000) continue;
    findings.push(...scanText(path, text));
  }
  return findings;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  scan().then(findings => {
    for (const f of findings) console.log(`${f.path}${f.line ? ':' + f.line : ''}  ${f.rule}`);
    console.log(findings.length ? `${findings.length} finding(s): do not push until resolved.` : 'No secrets or forbidden files found.');
    process.exitCode = findings.length ? 1 : 0;
  }).catch(error => { console.error(error.message); process.exitCode = 2; });
}
