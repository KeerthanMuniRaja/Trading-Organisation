// Self-repair for code updates (AUTO-05): when the rule bot's code changed but its rule did not, the agents prepare a
// release for the current code themselves, so a developer's fix never needs the owner to re-release by hand.
//   1. the cycle's release check refuses the bot only because the code fingerprint differs (same model, same rule version);
//   2. the RESEARCHER registers a release of the current code;
//   3. the EVALUATOR files the same regime-study fitness and evaluates the release on it.
// Nothing is staged here: the owner's standing approval `trialNewReleases` starts it as a canary, live fitness judges it,
// and `promoteCanaries` / `rollbackFailingReleases` keep or drop it. Without that approval it waits on the agenda.
//   node --env-file=.env scripts/release-renewal.mjs
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fitnessFrom, identity } from './activate-rule-bot.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function client(env, fetchImpl) {
  const base = (env.API_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
  if (!/^(https:\/\/[^/@?#]+|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?)$/.test(base)) throw new Error('Invalid backend API origin');
  const token = role => {
    const found = JSON.parse(env.PRINCIPALS_JSON || '[]').filter(p => p.role === role && !p.botId);
    if (found.length !== 1 || !found[0].token) throw new Error(`Configure exactly one ${role} credential`);
    return found[0].token;
  };
  return async (role, method, path, body, keyParts) => {
    const headers = { Authorization: 'Bearer ' + token(role), 'Content-Type': 'application/json' };
    if (keyParts) headers['Idempotency-Key'] = 'renewal-' + createHash('sha256').update(JSON.stringify(keyParts)).digest('hex').slice(0, 48);
    const r = await fetchImpl(base + path, { method, headers, redirect: 'error', ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text();
    if (!r.ok) throw new Error(`${path} refused (HTTP ${r.status}): ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  };
}

export async function renew(env, { fetchImpl = fetch, id, study }) {
  const botId = env.RULE_BOT_ID;
  if (!botId) return { state: 'skipped', reason: 'no rule bot configured (RULE_BOT_ID)' };
  const call = client(env, fetchImpl);
  const check = await call('evaluator', 'POST', '/v1/releases/check', { botId, model: id.model, promptVersion: id.promptVersion, codeFingerprint: id.codeFingerprint });
  if (check.allowed) return { state: 'current', releaseVersion: check.version, stage: check.stage };
  if (check.reason !== 'version-not-authorised') return { state: 'not-renewed', reason: check.reason };
  // only a code change under the SAME rule is renewed automatically; a changed rule is a new idea and goes through R&D
  if (check.authorised?.model !== id.model || check.authorised?.promptVersion !== id.promptVersion)
    return { state: 'not-renewed', reason: 'the rule itself changed; that is a new idea, not a code fix' };
  if (!study) return { state: 'not-renewed', reason: 'regime study missing: run regime_study.py' };
  const fitness = await call('evaluator', 'POST', '/v1/bots/fitness', fitnessFrom(study, id.model, botId), ['fitness', botId, id.model, study.from, study.through]);
  const release = await call('researcher', 'POST', '/v1/releases', { botId, model: id.model, promptVersion: id.promptVersion, codeFingerprint: id.codeFingerprint,
    notes: `Code update of the same rule (${id.promptVersion}); prepared automatically` }, ['release', botId, id.codeFingerprint]);
  const evaluation = await call('evaluator', 'POST', '/v1/releases/evaluations', { releaseId: release.id, fitnessReportId: fitness.id }, ['evaluation', release.id, fitness.id]);
  return { state: 'prepared', releaseVersion: release.version, fitness: fitness.verdict, canaryEligible: evaluation.canaryEligible,
    next: 'standing approval trialNewReleases starts it as a canary; otherwise it waits on the owner agenda' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  (async () => {
    const studyPath = join(ROOT, '.local', 'trading-desk', 'regime-study.json');
    const study = existsSync(studyPath) ? JSON.parse(await readFile(studyPath, 'utf8')) : null;
    console.log(JSON.stringify(await renew(process.env, { id: await identity(), study }), null, 2));
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}
