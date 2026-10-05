import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWED_TOOLS, StdioMcpClient, validateCall } from './mcp-client.mjs';
import { RUFLO_VERSION, requireRuntime } from './runtime.mjs';

export { RUFLO_VERSION } from './runtime.mjs';
const integrationDir = dirname(fileURLToPath(import.meta.url));
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/u.test(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const coordinationError = (code, message) => Object.assign(new Error(message), { code });

export function childEnvironment(stateDir, parent = process.env) {
  const env = {};
  for (const name of ['SystemRoot', 'SYSTEMROOT', 'WINDIR']) if (parent[name]) env[name] = parent[name];
  return { ...env, PATH: dirname(process.execPath), HOME: join(stateDir, 'home'), USERPROFILE: join(stateDir, 'home'),
    TEMP: join(stateDir, 'tmp'), TMP: join(stateDir, 'tmp'), TMPDIR: join(stateDir, 'tmp'),
    CLAUDE_FLOW_MCP_TOOLS: ALLOWED_TOOLS.join(','), NO_COLOR: '1' };
}

export class TaskJournal {
  records = new Map();
  #file; #lock; #lockPath; #handle;
  static async open(stateDir) {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const journal = new TaskJournal();
    journal.#file = join(stateDir, 'coordination.jsonl');
    journal.#lockPath = join(stateDir, 'coordinator.lock');
    journal.#lock = await open(journal.#lockPath, 'wx', 0o600).catch(() => { throw new Error('Coordinator state is locked; verify no live process before resolving a stale lock'); });
    try {
      await journal.#lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      let content = '';
      try {
        if ((await stat(journal.#file)).size > 2 * 1024 * 1024) throw new Error('Coordination journal size limit reached');
        content = await readFile(journal.#file, 'utf8');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (content && !content.endsWith('\n')) throw new Error('Incomplete coordination journal; explicit recovery required');
      for (const line of content.split('\n').filter(Boolean)) {
        const event = JSON.parse(line);
        if (!identifier(event.experimentId) || !['create_requested', 'created', 'completion_requested', 'completed'].includes(event.kind)) throw new Error('Invalid coordination journal');
        if (event.kind !== 'create_requested' && !/^task-[a-zA-Z0-9_-]{1,100}$/u.test(event.taskId ?? '')) throw new Error('Invalid journal task ID');
        if (event.kind === 'create_requested' && journal.records.has(event.experimentId)) throw new Error('Duplicate create intent in journal');
        if (event.kind !== 'create_requested' && !journal.records.has(event.experimentId)) throw new Error('Journal completion lacks create intent');
        journal.records.set(event.experimentId, { ...journal.records.get(event.experimentId), ...event });
      }
      journal.#handle = await open(journal.#file, 'a', 0o600);
      return journal;
    } catch (error) { await journal.close(); throw error; }
  }
  async append(event) {
    const entry = { ...event, recordedAt: new Date().toISOString() };
    await this.#handle.writeFile(JSON.stringify(entry) + '\n');
    await this.#handle.sync();
    this.records.set(entry.experimentId, { ...this.records.get(entry.experimentId), ...entry });
  }
  async close() {
    await this.#handle?.close();
    this.#handle = undefined;
    if (this.#lock) { await this.#lock.close(); this.#lock = undefined; await unlink(this.#lockPath); }
  }
}

export class RufloCoordinator {
  #client; #journal; #queue = Promise.resolve(); #closed = false;
  constructor(client, journal, contract = {}) { this.#client = client; this.#journal = journal; this.contract = contract; }
  static async open({ stateDir = join(integrationDir, '.state'), timeoutMs = 15000 } = {}) {
    await requireRuntime();
    stateDir = resolve(stateDir);
    const journal = await TaskJournal.open(stateDir);
    let client;
    try {
      const modules = join(integrationDir, 'node_modules');
      for (const name of ['ruflo', '@claude-flow/cli']) {
        const pkg = JSON.parse(await readFile(join(modules, name, 'package.json'), 'utf8'));
        if (pkg.version !== RUFLO_VERSION) throw new Error(`Pinned ${name}@${RUFLO_VERSION} is required`);
      }
      for (const folder of ['home', 'tmp', 'workspace']) await mkdir(join(stateDir, folder), { recursive: true, mode: 0o700 });
      const child = spawn(process.execPath, [join(modules, 'ruflo', 'bin', 'ruflo.js'), 'mcp', 'start', '--transport', 'stdio', '--tools', ALLOWED_TOOLS.join(',')], {
        cwd: join(stateDir, 'workspace'), env: childEnvironment(stateDir), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      client = new StdioMcpClient(child, { timeoutMs });
      const contract = await client.initialize();
      return new RufloCoordinator(client, journal, contract);
    } catch (error) { await client?.close(); await journal.close(); throw error; }
  }
  #serial(operation) {
    if (this.#closed) return Promise.reject(new Error('Coordinator is closed'));
    const result = this.#queue.then(operation);
    this.#queue = result.catch(() => {});
    return result;
  }
  createResearchTask(experimentId, summary) {
    return this.#serial(async () => {
      if (!identifier(experimentId) || typeof summary !== 'string' || summary.length < 1 || summary.length > 2000) throw new Error('Invalid experiment or summary');
      const summaryDigest = digest(summary);
      const previous = this.#journal.records.get(experimentId);
      if (previous) {
        if (previous.summaryDigest !== summaryDigest) throw new Error('Experiment identity reused with a different summary');
        if (!previous.taskId) throw coordinationError('RECONCILIATION_REQUIRED', 'Previous task creation has unknown outcome; reconcile before retrying');
        return { taskId: previous.taskId, reused: true };
      }
      if (this.#journal.records.size >= 100) throw coordinationError('CAPACITY_REACHED', 'Coordinator task capacity reached');
      const args = { type: 'research', description: `Application experiment ${experimentId}: ${summary}`, priority: 'normal', assignTo: [], tags: ['trading-organisation', `experiment-${experimentId}`] };
      validateCall('task_create', args);
      await this.#journal.append({ kind: 'create_requested', experimentId, summaryDigest });
      const task = await this.#client.call('task_create', args);
      if (!/^task-[a-zA-Z0-9_-]{1,100}$/u.test(task.taskId ?? '') || task.type !== 'research' || task.status !== 'pending' || task.assignedTo?.length !== 0) throw new Error('Unexpected created task; explicit reconciliation required');
      await this.#journal.append({ kind: 'created', experimentId, taskId: task.taskId });
      return { taskId: task.taskId, reused: false };
    });
  }
  getResearchTask(experimentId) {
    return this.#serial(async () => {
      const record = this.#record(experimentId);
      const result = await this.#client.call('task_status', { taskId: record.taskId });
      if (result.taskId !== record.taskId || result.type !== 'research') throw new Error('Ruflo task identity mismatch');
      return result;
    });
  }
  completeResearchTask(experimentId, { resultReference, outcome }) {
    return this.#serial(async () => {
      const record = this.#record(experimentId);
      const result = { resultReference, outcome, authority: 'application-owned' };
      validateCall('task_complete', { taskId: record.taskId, result });
      const resultDigest = digest(JSON.stringify(result));
      if (record.resultDigest && record.resultDigest !== resultDigest) throw coordinationError('RECONCILIATION_REQUIRED', 'Completion differs from recorded application result');
      if (record.kind === 'completed') {
        return { taskId: record.taskId, status: 'completed', reused: true };
      }
      if (record.kind !== 'completion_requested') await this.#journal.append({ kind: 'completion_requested', experimentId, taskId: record.taskId, resultDigest });
      const completed = await this.#client.call('task_complete', { taskId: record.taskId, result });
      if (completed.taskId !== record.taskId || completed.status !== 'completed') throw new Error('Unexpected task completion response');
      validateCall('task_complete', { taskId: record.taskId, result: completed.result });
      const acknowledged = { resultReference: completed.result.resultReference, outcome: completed.result.outcome, authority: completed.result.authority };
      if (digest(JSON.stringify(acknowledged)) !== resultDigest) throw coordinationError('RECONCILIATION_REQUIRED', 'Upstream completion differs from the application result');
      await this.#journal.append({ kind: 'completed', experimentId, taskId: record.taskId, resultDigest });
      return { taskId: record.taskId, status: 'completed', reused: false };
    });
  }
  #record(experimentId) {
    if (!identifier(experimentId)) throw new Error('Invalid experiment ID');
    const record = this.#journal.records.get(experimentId);
    if (!record?.taskId) throw new Error('Task is not owned by this coordinator or needs reconciliation');
    return record;
  }
  async close() {
    this.#closed = true;
    await this.#queue;
    try { await this.#client.close(); } finally { await this.#journal.close(); }
  }
}
