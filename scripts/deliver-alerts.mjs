// Alert delivery worker (OBS-01): run one alert cycle, deliver undelivered open alerts, mark them delivered.
// Channel: always appended to .local/alerts/outbox.jsonl; additionally POSTed as JSON to ALERT_WEBHOOK_URL when set
// (HTTPS only, no credentials in the URL, redirects refused). Uses the single evaluator credential from .env.
// Only alerts actually handed to every configured channel are marked delivered, so a failure is retried next run.
//   node --env-file=.env scripts/deliver-alerts.mjs
import { appendFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function settings(env) {
  const base = (env.API_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
  if (!/^(https:\/\/[^/@?#]+|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?)$/.test(base)) throw new Error('Invalid backend API origin');
  const evaluators = JSON.parse(env.PRINCIPALS_JSON || '[]').filter(p => p.role === 'evaluator');
  if (evaluators.length !== 1 || !evaluators[0].token) throw new Error('Configure exactly one evaluator credential');
  let webhook = null;
  if (env.ALERT_WEBHOOK_URL) {
    const url = new URL(env.ALERT_WEBHOOK_URL);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('ALERT_WEBHOOK_URL must be HTTPS without embedded credentials');
    webhook = url.href;
  }
  return { base, token: evaluators[0].token, webhook, outbox: resolve(env.ALERT_OUTBOX || '.local/alerts/outbox.jsonl') };
}

export async function deliver(env, { fetchImpl = fetch, now = () => new Date() } = {}) {
  const s = settings(env);
  const call = async (path, body) => {
    const response = await fetchImpl(s.base + '/v1' + path, { method: 'POST', redirect: 'error', body: JSON.stringify(body ?? {}),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.token, 'Idempotency-Key': 'alerts-' + randomUUID() } });
    if (!response.ok) throw new Error(`${path} refused (HTTP ${response.status})`);
    return response.json();
  };
  const cycle = await call('/alerts/cycles');
  const { alerts, undelivered } = await call('/alerts/query', {});
  const pending = alerts.filter(a => undelivered.includes(a.id));
  const delivered = [];
  for (const a of pending) {
    const message = { at: now().toISOString(), severity: a.severity, rule: a.rule, subject: a.subject, message: a.message, raisedAt: a.raisedAt, id: a.id };
    try {
      await mkdir(dirname(s.outbox), { recursive: true });
      await appendFile(s.outbox, JSON.stringify(message) + '\n');
      if (s.webhook) {
        const response = await fetchImpl(s.webhook, { method: 'POST', redirect: 'error', body: JSON.stringify(message),
          headers: { 'Content-Type': 'application/json', Title: `[${a.severity}] ${a.rule}`.slice(0, 120) }, signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error('webhook HTTP ' + response.status);
      }
      delivered.push(a.id);
    } catch { /* left undelivered; retried on the next run */ }
  }
  if (delivered.length) await call('/alerts/deliveries', { alertIds: delivered });
  return { raised: cycle.raised.length, resolved: cycle.resolved, open: cycle.open, delivered: delivered.length, failed: pending.length - delivered.length,
    channel: s.webhook ? 'outbox+webhook' : 'outbox' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  deliver(process.env).then(r => console.log(JSON.stringify(r))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
