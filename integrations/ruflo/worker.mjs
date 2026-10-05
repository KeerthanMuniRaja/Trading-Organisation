import { setTimeout as sleep } from 'node:timers/promises';
import { createBackendClient, mirrorOnce, failureCode, BackendFailure } from './mirror.mjs';
import { requireRuntime } from './runtime.mjs';
const once = process.argv.includes('--once');
const stopping = new AbortController();
process.once('SIGINT', () => stopping.abort());
process.once('SIGTERM', () => stopping.abort());
const client = createBackendClient({ base: process.env.API_URL ?? 'http://127.0.0.1:3000', token: process.env.API_TOKEN, signal: stopping.signal });
try {
  do {
    try {
      await requireRuntime();
      const result = await mirrorOnce({ client, stateDir: process.env.RUFLO_STATE_DIR, signal: stopping.signal });
      await client.status({ state: 'healthy', code: 'SYNCED', taskCount: result.taskCount });
      console.log(JSON.stringify({ event: 'ruflo.tasks.mirrored', ...result, authority: 'application-owned' }));
    } catch (error) {
      if (stopping.signal.aborted) break;
      const code = failureCode(error);
      try { await client.status({ state: 'degraded', code, taskCount: 0 }); }
      catch { console.error(JSON.stringify({ event: 'ruflo.notification.unavailable', code })); }
      console.error(JSON.stringify({ event: 'ruflo.mirror.failed', code, action: 'Inspect Ruflo diagnostics; financial execution remains core-owned' }));
      // Only known temporary backend failures are automatically retried.
      // An uncertain MCP write requires reconciliation, not blind replay.
      if (once || !(error instanceof BackendFailure && error.retryable)) { process.exitCode = 1; break; }
    }
    if (!once) await sleep(5000, undefined, { signal: stopping.signal });
  } while (!once && !stopping.signal.aborted);
} catch (error) {
  if (!stopping.signal.aborted) { console.error(JSON.stringify({ event: 'ruflo.worker.failed', code: failureCode(error) })); process.exitCode = 1; }
}
