// The owner's self-expiring protections (PROTECT-01): loss brakes that pause a bot's new buys by themselves and lift by
// themselves; exits are never blocked. Nothing is paused until the owner sets a policy. See docs/protections.md.
//   npm run protections                                         the policy and which bots are paused now
//   npm run protections -- set <policy.json> --reason "why"     replace the policy (owner credential; history is kept)
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function owner(env) {
  const base = (env.API_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
  if (!/^(https:\/\/[^/@?#]+|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?)$/.test(base)) throw new Error('Invalid backend API origin');
  const found = JSON.parse(env.PRINCIPALS_JSON || '[]').filter(p => p.role === 'owner');
  if (found.length !== 1 || !found[0].token) throw new Error('Configure exactly one owner credential');
  return { base, token: found[0].token };
}

export async function show(env, fetchImpl = fetch) {
  const { base, token } = owner(env);
  const r = await fetchImpl(base + '/v1/protections/status', { method: 'POST', body: '{}', redirect: 'error',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } });
  if (!r.ok) throw new Error(`/v1/protections/status refused (HTTP ${r.status})`);
  return JSON.parse(await r.text());
}

export async function set(env, rules, reason, fetchImpl = fetch) {
  if (!reason?.trim()) throw new Error('Say why: --reason "..."');
  const { base, token } = owner(env), body = JSON.stringify({ rules, reason });
  const r = await fetchImpl(base + '/v1/protections/policy', { method: 'POST', redirect: 'error', body, headers: { Authorization: 'Bearer ' + token,
    'Content-Type': 'application/json', 'Idempotency-Key': 'protections-' + createHash('sha256').update(body).digest('hex').slice(0, 48) } });
  const text = await r.text();
  if (!r.ok) throw new Error(`/v1/protections/policy refused (HTTP ${r.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function main() {
  const args = process.argv.slice(2), [command = 'show', file] = args.filter(a => !a.startsWith('--'));
  const at = args.indexOf('--reason'), reason = at >= 0 ? args[at + 1] : args.find(a => a.startsWith('--reason='))?.slice(9);
  if (command === 'show') { console.log(JSON.stringify(await show(process.env), null, 2)); return; }
  if (command !== 'set' || !file) throw new Error('Usage: npm run protections [-- set <policy.json> --reason "why"]');
  // the file may hold just the rules, or a suggested policy with a note next to them
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  console.log(JSON.stringify(await set(process.env, parsed.rules ?? parsed, reason), null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(dirname(fileURLToPath(import.meta.url)), 'protections.mjs')) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
