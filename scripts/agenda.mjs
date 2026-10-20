// The owner's agenda (ORG-02): everything the organisation is waiting on the owner for, and one command per decision.
// Bots propose and the daily management review recommends; this applies the owner's answer through the existing owner
// routes, so every rule (department ceilings, fresh evaluations, knowledge transfer on retirement) is still enforced there.
//   npm run agenda                                     list what is waiting
//   npm run agenda -- accept <id> [--note "..."]       say yes (a department also needs --budget-paise=<paise>)
//   npm run agenda -- decline <id> [--note "..."]      say no
// An <id> may be shortened to its first 8 characters. Every decision is idempotent: a rerun changes nothing.
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function client(env, fetchImpl) {
  const base = (env.API_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
  if (!/^(https:\/\/[^/@?#]+|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?)$/.test(base)) throw new Error('Invalid backend API origin');
  const owners = JSON.parse(env.PRINCIPALS_JSON || '[]').filter(p => p.role === 'owner');
  if (owners.length !== 1 || !owners[0].token) throw new Error('Configure exactly one owner credential');
  return async (method, path, body, keyParts) => {
    const headers = { Authorization: 'Bearer ' + owners[0].token, 'Content-Type': 'application/json' };
    if (keyParts) headers['Idempotency-Key'] = 'agenda-' + createHash('sha256').update(JSON.stringify(keyParts)).digest('hex').slice(0, 48);
    const r = await fetchImpl(base + path, { method, headers, redirect: 'error', ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text();
    if (!r.ok) throw new Error(`${path} refused (HTTP ${r.status}): ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  };
}

/** One line per waiting decision, for the terminal. */
export function describe(item) {
  const head = `${item.id.slice(0, 8)}  ${item.type.padEnd(13)}`;
  if (item.type === 'recommendation') return `${head} ${item.botId}: ${item.kind}${item.proposedBudgetPaise ? ` to Rs ${Number(item.proposedBudgetPaise) / 100}` : ''} — ${item.reason}`;
  if (item.type === 'birth') return `${head} new bot ${item.botId} in ${item.department} (${item.specialty}) — ${item.opportunity}`;
  if (item.type === 'department') return `${head} ${item.kind} department ${item.departmentId} — ${item.rationale}`;
  if (item.type === 'release') return `${head} ${item.botId}: activate release v${item.version} (${item.model}; evaluated ${item.fitnessVerdict})`;
  if (item.type === 'budget') return `${head} ${item.botId}: qualified with no budget; accept with --budget-paise=<paise>`;
  return `${head} ${item.botId}: start paper trading on its active release`;
}

/** Finds one waiting item by its full id or a prefix of at least 8 characters. */
export function find(items, id) {
  if (!id || id.length < 8) throw new Error('Give the item id (at least its first 8 characters)');
  const matches = items.filter(i => i.id === id || i.id.startsWith(id));
  if (matches.length !== 1) throw new Error(matches.length ? `"${id}" matches ${matches.length} items; give more characters` : `Nothing waiting with id "${id}"`);
  return matches[0];
}

/** Applies the owner's answer to one item. Returns what was done. */
export async function decide(env, { id, accept, note, budgetPaise, fetchImpl = fetch }) {
  const call = client(env, fetchImpl);
  const item = find((await call('GET', '/v1/organisation/agenda')).items, id);
  const why = note || (accept ? 'Accepted on the owner agenda' : 'Declined on the owner agenda');
  const k = [item.type, item.id, accept];
  if (item.type === 'recommendation') {
    if (accept && item.kind === 'retire') {
      // retirement hands on everything the bot learned, then the recommendation records the owner's decision
      const lessons = ((await call('GET', '/v1/knowledge')).lessons ?? []).filter(l => l.bot_id === item.botId).map(l => l.id);
      await call('POST', '/v1/bots/retirements', { botId: item.botId, reason: why, transferLessonIds: lessons.slice(0, 50) }, ['retire', ...k]);
    }
    return call('POST', '/v1/management/decisions', { recommendationId: item.id, outcome: accept ? 'accepted' : 'declined', note: why }, k);
  }
  if (item.type === 'birth')
    return call('POST', '/v1/bots/births/decisions', { proposalId: item.id, outcome: accept ? 'approved' : 'rejected', note: why }, k);
  if (item.type === 'department') {
    if (accept && item.kind === 'open' && !/^\d{1,15}$/.test(budgetPaise ?? '')) throw new Error('Opening a department needs its budget ceiling: --budget-paise=<paise>');
    return call('POST', '/v1/departments/decisions', { proposalId: item.id, outcome: accept ? 'approved' : 'rejected', note: why,
      ...(accept && item.kind === 'open' ? { budgetPaise } : {}) }, k);
  }
  if (item.type === 'release')
    // declining revokes the release: it can never be staged again (register a new one instead)
    return call('POST', '/v1/releases/stages', { releaseId: item.id, stage: accept ? 'active' : 'revoked', reason: why }, k);
  if (item.type === 'budget') {
    if (!accept) return { botId: item.botId, note: 'Nothing recorded: it stays at zero budget, so it cannot buy' };
    if (!/^\d{1,15}$/.test(budgetPaise ?? '') || budgetPaise === '0') throw new Error('Give its budget: --budget-paise=<paise>');
    return call('POST', '/v1/bots/budgets', { botId: item.botId, budgetPaise, reason: why }, [...k, budgetPaise]);
  }
  if (!accept) return { botId: item.botId, note: 'Nothing recorded: the bot simply stays where it is until you qualify it' };
  return call('POST', '/v1/releases/qualifications', { botId: item.botId, reason: why }, k);
}

export async function list(env, fetchImpl = fetch) {
  return (await client(env, fetchImpl)('GET', '/v1/organisation/agenda'));
}

async function main() {
  const args = process.argv.slice(2), [command = 'list', id] = args.filter(a => !a.startsWith('--'));
  const option = name => { const i = args.indexOf('--' + name); const inline = args.find(a => a.startsWith(`--${name}=`));
    return inline ? inline.slice(name.length + 3) : i >= 0 ? args[i + 1] : undefined; };
  if (command === 'list') {
    const agenda = await list(process.env);
    if (!agenda.items.length) { console.log('Nothing is waiting for you.'); return; }
    console.log(`${agenda.waiting} decision(s) waiting:\n` + agenda.items.map(describe).join('\n')
      + '\n\nAnswer with: npm run agenda -- accept <id>   or   npm run agenda -- decline <id>');
    return;
  }
  if (command !== 'accept' && command !== 'decline') throw new Error(`Unknown command "${command}" (list, accept, decline)`);
  console.log(JSON.stringify(await decide(process.env, { id, accept: command === 'accept', note: option('note'), budgetPaise: option('budget-paise') }), null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(dirname(fileURLToPath(import.meta.url)), 'agenda.mjs')) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
