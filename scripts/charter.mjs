// The founder charter (CHARTER-01): one file with every boundary the owner sets once, applied with one command, after
// which the organisation runs itself inside it. It sets the standing approvals (scripts/autonomy.mjs) and the loss brakes
// with the last-resort stop (scripts/protections.mjs) together, each with the same reason, and shows what is in force.
//   npm run charter                                              what is in force now
//   npm run charter -- set docs/policies/founder-charter.json --reason "why"
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { set as setAutonomy, show as showAutonomy } from './autonomy.mjs';
import { set as setProtections, show as showProtections } from './protections.mjs';

/** The charter's two parts, checked for shape before anything is sent (the backend checks every value again). */
export function parts(charter) {
  if (!charter || typeof charter !== 'object' || !charter.autonomy || !charter.protections) {
    throw new Error('A charter has two parts: "autonomy" (standing approvals) and "protections" (loss brakes and the last-resort stop)');
  }
  return { autonomy: charter.autonomy, protections: charter.protections };
}

export async function set(env, charter, reason, fetchImpl = fetch) {
  if (!reason?.trim()) throw new Error('Say why: --reason "..."');
  const { autonomy, protections } = parts(charter);
  // protections first: the brakes and the stop are in place before any automatic decision can add risk
  const brakes = await setProtections(env, protections, `Founder charter: ${reason}`, fetchImpl);
  const approvals = await setAutonomy(env, autonomy, `Founder charter: ${reason}`, fetchImpl);
  return { protections: brakes, autonomy: approvals };
}

export async function show(env, fetchImpl = fetch) {
  return { autonomy: await showAutonomy(env, fetchImpl), protections: await showProtections(env, fetchImpl) };
}

async function main() {
  const args = process.argv.slice(2), [command = 'show', file] = args.filter(a => !a.startsWith('--'));
  const at = args.indexOf('--reason'), reason = at >= 0 ? args[at + 1] : args.find(a => a.startsWith('--reason='))?.slice(9);
  if (command === 'show') { console.log(JSON.stringify(await show(process.env), null, 2)); return; }
  if (command !== 'set' || !file) throw new Error('Usage: npm run charter [-- set <charter.json> --reason "why"]');
  console.log(JSON.stringify(await set(process.env, JSON.parse(await readFile(file, 'utf8')), reason), null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(dirname(fileURLToPath(import.meta.url)), 'charter.mjs')) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
