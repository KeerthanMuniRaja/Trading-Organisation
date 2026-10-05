import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { RufloCoordinator } from './coordinator.mjs';

export class BackendFailure extends Error {
  constructor(retryable) {
    super(retryable ? 'Coordination backend temporarily unavailable' : 'Coordination backend rejected the request');
    this.code = 'BACKEND_UNAVAILABLE';
    this.retryable = retryable;
  }
}

export function createBackendClient({ base, token, signal, fetchImpl = fetch, delay = sleep }) {
  const origin = new URL(base);
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/'
    || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)))) {
    throw new Error('A safe backend origin is required');
  }
  if (!/^[A-Za-z0-9_-]{43,200}$/.test(token ?? '')) throw new Error('A coordinator-scoped API_TOKEN is required');
  const request = async (path, body) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      try {
        const response = await fetchImpl(origin.origin + '/v1' + path, {
          method: body === undefined ? 'GET' : 'POST', redirect: 'error',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new BackendFailure([429, 500, 502, 503, 504].includes(response.status));
        }
        const chunks = []; let size = 0;
        for await (const chunk of response.body ?? []) {
          size += chunk.length;
          if (size > 1024 * 1024) throw new Error('Coordination response size limit exceeded');
          chunks.push(chunk);
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (error) {
        signal?.throwIfAborted();
        const temporary = error instanceof BackendFailure ? error.retryable : ['TypeError', 'TimeoutError'].includes(error.name);
        if (!temporary || attempt === 2) throw error instanceof BackendFailure ? error : new BackendFailure(temporary);
        await delay(200 * 2 ** attempt, undefined, { signal });
      }
    }
  };
  return {
    tasks: () => request('/coordination/tasks'),
    status: status => request('/coordination/status', status),
  };
}

export function validateTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length > 100) throw new Error('Invalid coordination feed');
  const identities = new Set();
  const allowed = ['id', 'bot_id', 'hypothesis', 'state', 'created_at'];
  for (const task of tasks) {
    if (!task || Object.keys(task).some(key => !allowed.includes(key))
      || !/^[a-zA-Z0-9_-]{1,100}$/.test(task.id ?? '') || identities.has(task.id)
      || !/^[a-zA-Z0-9_-]{1,80}$/.test(task.bot_id ?? '')
      || !['queued', 'evaluating', 'passed', 'rejected'].includes(task.state)
      || typeof task.hypothesis !== 'string' || !task.hypothesis.trim() || task.hypothesis.length > 4000
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(task.hypothesis)
      || typeof task.created_at !== 'string' || !Number.isFinite(Date.parse(task.created_at))) throw new Error('Invalid coordination task');
    identities.add(task.id);
  }
  return tasks;
}

export async function mirrorOnce({ client, stateDir, signal, openCoordinator = options => RufloCoordinator.open(options) }) {
  const tasks = validateTasks(await client.tasks());
  const result = { taskCount: tasks.length, created: 0, completed: 0 };
  // 2 handshake calls + at most 50 task calls fit the 64-request MCP budget.
  for (let offset = 0; offset < Math.max(1, tasks.length); offset += 25) {
    signal?.throwIfAborted();
    const coordinator = await openCoordinator({ stateDir });
    try {
      for (const task of tasks.slice(offset, offset + 25)) {
        signal?.throwIfAborted();
        const summary = task.hypothesis.length <= 2000 ? task.hypothesis : task.hypothesis.slice(0, 1800)
          + ' [full hypothesis SHA-256: ' + createHash('sha256').update(task.hypothesis).digest('hex') + ']';
        if (!(await coordinator.createResearchTask(task.id, summary)).reused) result.created++;
        if (task.state === 'passed' || task.state === 'rejected') {
          const completion = await coordinator.completeResearchTask(task.id, {
            resultReference: 'experiment:' + task.id, outcome: task.state === 'passed' ? 'completed' : 'rejected',
          });
          if (!completion.reused) result.completed++;
        }
      }
    } finally { await coordinator.close(); }
  }
  return result;
}

export function failureCode(error) {
  return ['OS_PROFILE_UNAVAILABLE', 'DEPENDENCIES_UNAVAILABLE', 'BACKEND_UNAVAILABLE', 'RECONCILIATION_REQUIRED', 'CAPACITY_REACHED'].includes(error.code)
    ? error.code : 'MCP_UNAVAILABLE';
}
