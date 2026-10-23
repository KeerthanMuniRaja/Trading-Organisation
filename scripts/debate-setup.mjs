// The debate desk's setup is the member-setup preset 'debaters' (kept so existing instructions still work).
//   node --env-file=.env scripts/debate-setup.mjs plan | apply --yes
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { PRESETS, withMembers } from './member-setup.mjs';

export const DEBATERS = PRESETS.debaters;
export const withDebaters = envText => withMembers(envText, DEBATERS);

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command = 'plan'] = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const args = command === 'apply' ? ['apply', 'debaters', ...process.argv.slice(2).filter(a => a.startsWith('--'))] : ['plan'];
  process.exitCode = spawnSync(process.execPath, [resolve(dirname(fileURLToPath(import.meta.url)), 'member-setup.mjs'), ...args], { stdio: 'inherit' }).status ?? 1;
}
