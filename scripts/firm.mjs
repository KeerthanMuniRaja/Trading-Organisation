// The firm (ORG-01): turn the bot groups that already exist (each bot's department label) into registered departments,
// through the backend's own rules: a department opens only on a proposal citing VERIFIED evidence, decided by the owner
// with its budget ceiling. The evidence is the organisation's own record of the group, reported by the researcher and
// verified by the evaluator only when its own read gives exactly the same text (content-bound, as rnd_scout.propose).
//   npm run firm -- plan             what would be proposed, with the recommended ceilings (owner view, changes nothing)
//   npm run firm -- source --yes     owner, once: register and approve the source 'organisation-records'
//   npm run firm -- propose          agents: evidence, verification and an open proposal for each unregistered label
// Then the owner decides on the agenda: npm run agenda -- accept <id> --budget-paise=<ceiling>
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCE = { id: 'organisation-records', name: "The organisation's own records (computed by its agents)",
  url: 'https://github.com/KeerthanMuniRaja/Trading-Organisation' };

export function client(env, fetchImpl = fetch) {
  const base = (env.API_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
  if (!/^(https:\/\/[^/@?#]+|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?)$/.test(base)) throw new Error('Invalid backend API origin');
  const token = role => {
    const found = JSON.parse(env.PRINCIPALS_JSON || '[]').filter(p => p.role === role && !p.botId);
    if (found.length !== 1 || !found[0].token) throw new Error(`Configure exactly one ${role} credential`);
    return found[0].token;
  };
  return async (role, method, path, body) => {
    const headers = { Authorization: 'Bearer ' + token(role), 'Content-Type': 'application/json' };
    if (method === 'POST') headers['Idempotency-Key'] = 'firm-' + createHash('sha256').update(path + JSON.stringify(body)).digest('hex').slice(0, 48);
    const r = await fetchImpl(base + path, { method, headers, redirect: 'error', ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text();
    if (!r.ok) throw new Error(`${path} refused (HTTP ${r.status}): ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  };
}

/** The group's record as evidence text: who is in it, what each does and its state. Any reader computes the same text
 *  from GET /v1/bots, so the evaluator can check it word for word. */
export function recordText(label, bots, day) {
  const members = bots.filter(b => b.department === label && b.state !== 'retired').sort((a, b) => a.id.localeCompare(b.id));
  return `Organisation records, ${day}: the bot group '${label}' has ${members.length} active member(s): `
    + members.map(b => `${b.id} (${b.specialty}, ${b.method}, ${b.state})`).join('; ')
    + '. They already work under this label in the daily cycle; a registered department gives them a charter, a lead and a budget ceiling.';
}

/** What would be proposed: each unregistered label with a charter, its members and a ceiling equal to its members'
 *  current budgets (registering a department moves no money). `budgets`: botId -> paise, from the owner's view. */
export function plan(registry, bots, charters, budgets = {}) {
  return (registry.unregisteredLabels ?? []).map(label => {
    const members = bots.filter(b => b.department === label && b.state !== 'retired');
    const charter = charters[label];
    const ceiling = members.reduce((sum, b) => sum + BigInt(budgets[b.id] ?? 0), 0n);
    return { departmentId: label, name: charter?.name ?? null, mandate: charter?.mandate ?? null, members: members.map(b => `${b.id} (${b.state})`),
      recommendedCeilingPaise: ceiling.toString(), ...(charter ? {} : { problem: `no charter for '${label}' in config/departments.json` }) };
  });
}

export async function propose(env, { fetchImpl = fetch, charters, now = new Date() } = {}) {
  const call = client(env, fetchImpl);
  const registry = await call('researcher', 'GET', '/v1/departments');
  const pending = new Set((registry.pendingProposals ?? []).map(p => p.departmentId));
  const day = now.toISOString().slice(0, 10), out = [];
  for (const label of registry.unregisteredLabels ?? []) {
    if (pending.has(label)) { out.push({ departmentId: label, state: 'already proposed' }); continue; }
    const charter = charters[label];
    if (!charter) { out.push({ departmentId: label, state: 'no charter', next: `add '${label}' to config/departments.json` }); continue; }
    const text = recordText(label, await call('researcher', 'GET', '/v1/bots'), day);
    const evidence = await call('researcher', 'POST', '/v1/evidence', { sourceId: SOURCE.id, kind: 'dataset', content: text, publishedAt: now.toISOString() });
    if (evidence.status !== 'verified') {
      // the evaluator's own read: anything different is not the evidence it verifies
      const mine = recordText(label, await call('evaluator', 'GET', '/v1/bots'), day);
      await call('evaluator', 'POST', '/v1/evidence/reviews', { evidenceId: evidence.id, status: mine === text ? 'verified' : 'rejected',
        expected: { content: text, sourceId: SOURCE.id, kind: 'dataset', publishedAt: now.toISOString() } });
      if (mine !== text) { out.push({ departmentId: label, state: 'evidence rejected: the evaluator read a different record' }); continue; }
    }
    const proposal = await call('researcher', 'POST', '/v1/departments/proposals', { kind: 'open', departmentId: label, name: charter.name,
      mandate: charter.mandate, rationale: `${text} Charter: ${charter.mandate}`.slice(0, 1000), evidenceIds: [evidence.id] });
    out.push({ departmentId: label, state: 'proposed', proposalId: proposal.id });
  }
  return out;
}

async function main() {
  const [command] = process.argv.slice(2);
  const charters = JSON.parse(await readFile(join(ROOT, 'config', 'departments.json'), 'utf8')).departments;
  const call = client(process.env);
  if (command === 'plan') {
    const registry = await call('owner', 'GET', '/v1/departments');
    const bots = await call('owner', 'GET', '/v1/bots');
    const perf = await call('owner', 'GET', '/v1/paper/performance');
    const budgets = Object.fromEntries((perf.bots ?? []).map(b => [b.botId, b.budgetPaise ?? '0']));
    console.log(JSON.stringify({ proposals: plan(registry, bots, charters, budgets), registered: (registry.departments ?? []).map(d => d.id),
      next: 'npm run firm -- source --yes (once), then npm run firm -- propose; then decide on the agenda with --budget-paise' }, null, 2));
  } else if (command === 'source') {
    if (!process.argv.includes('--yes')) throw new Error('Registering a source is the owner\'s decision: add --yes');
    await call('owner', 'POST', '/v1/sources', { ...SOURCE, approved: true }).catch(error => { if (!/already exists/i.test(error.message)) throw error; });
    console.log(JSON.stringify({ source: SOURCE.id, state: 'registered and approved', next: 'npm run firm -- propose' }));
  } else if (command === 'propose') {
    console.log(JSON.stringify({ results: await propose(process.env, { charters }),
      next: 'npm run agenda (each department proposal), then: npm run agenda -- accept <id> --budget-paise=<ceiling from firm plan>' }, null, 2));
  } else throw new Error('Use: plan | source --yes | propose');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error('firm: ' + error.message); process.exitCode = 1; });
}
