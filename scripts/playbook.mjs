// Problem playbook (OPS-02): a failed or degraded cycle step is matched to a known problem, with its likely cause, the
// safe fix and who decides (agents may retry or repair; only the owner touches money, limits, sources or data
// confirmations). Entries live in integrations/trading-desk/knowledge/problems.json; the first match wins.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PLAYBOOK = join(ROOT, 'integrations', 'trading-desk', 'knowledge', 'problems.json');

export function loadPlaybook(path = PLAYBOOK) {
  const { problems } = JSON.parse(readFileSync(path, 'utf8'));
  return problems.map(p => ({ ...p, stepPattern: p.step ? new RegExp(p.step) : null, textPattern: p.text ? new RegExp(p.text, 'i') : null }));
}

let cached = null;
/** The playbook entry for a step's failure ({id, cause, fix, decidedBy}); never throws. */
export function diagnose(stepId, text, problems = null) {
  try {
    const list = problems ?? (cached ??= loadPlaybook());
    const hit = list.find(p => (!p.stepPattern || p.stepPattern.test(stepId)) && (!p.textPattern || p.textPattern.test(String(text ?? ''))));
    return hit ? { id: hit.id, cause: hit.cause, fix: hit.fix, decidedBy: hit.decidedBy } : null;
  } catch { return null; }
}
