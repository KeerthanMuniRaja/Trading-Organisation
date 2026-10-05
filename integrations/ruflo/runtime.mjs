import { userInfo } from 'node:os';
import { isAbsolute, dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const RUFLO_VERSION = '3.51.1';
const root = dirname(fileURLToPath(import.meta.url));

export function validateIdentity(identity) {
  return typeof identity?.username === 'string' && identity.username.length > 0
    && typeof identity.homedir === 'string' && isAbsolute(identity.homedir);
}

export async function inspectRuntime() {
  const checks = [];
  checks.push({ name: 'node', ok: Number(process.versions.node.split('.')[0]) === 24 });
  for (const name of ['ruflo', '@claude-flow/cli']) {
    try {
      const pkg = JSON.parse(await readFile(join(root, 'node_modules', name, 'package.json'), 'utf8'));
      checks.push({ name, ok: pkg.version === RUFLO_VERSION, installed: pkg.version, required: RUFLO_VERSION });
    } catch { checks.push({ name, ok: false, required: RUFLO_VERSION }); }
  }
  // Ruflo uses this actual OS identity for its policy trust anchor and mission actor.
  // Environment-variable homes are not a substitute for that identity.
  try { checks.push({ name: 'os-profile', ok: validateIdentity(userInfo()) }); }
  catch { checks.push({ name: 'os-profile', ok: false }); }
  const failed = checks.find(c => !c.ok);
  const code = !failed ? 'SYNCED' : failed.name === 'os-profile' ? 'OS_PROFILE_UNAVAILABLE' : 'DEPENDENCIES_UNAVAILABLE';
  return { ready: !failed, code, checks, nextAction: !failed ? null : code === 'OS_PROFILE_UNAVAILABLE'
    ? 'Run npm run test:ruflo:live in a normal terminal on a host with a working Node OS user profile. Security-policy checks remain enabled.'
    : 'Use Node 24 and run npm ci --ignore-scripts --omit=optional in integrations/ruflo.' };
}

export async function requireRuntime() {
  const report = await inspectRuntime();
  if (!report.ready) {
    const error = new Error(report.nextAction);
    error.code = report.code;
    throw error;
  }
  return report;
}
