import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALLOWED_TOOLS, EXPECTED_CONTRACTS, StdioMcpClient, validateCall, verifyContracts } from './mcp-client.mjs';
import { childEnvironment, RufloCoordinator, TaskJournal } from './coordinator.mjs';

const contracts = () => Object.entries(EXPECTED_CONTRACTS).map(([name, schema]) => ({ name, inputSchema: { type: 'object', required: [...schema.required], properties: Object.fromEntries(Object.entries(schema.properties).map(([key, type]) => [key, { type }])) } }));
const createArgs = () => ({ type: 'research', description: 'Study a synthetic experiment', priority: 'normal', assignTo: [], tags: ['trading-organisation', 'experiment-exp1'] });

test('deny execution, spawning, arbitrary tools and unsafe task arguments', () => {
  for (const name of ['agent_spawn', 'swarm_init', 'terminal_execute', 'task_orchestrate', 'wallet_transfer', 'memory_store']) assert.throws(() => validateCall(name, {}), /denied/);
  assert.doesNotThrow(() => validateCall('task_create', createArgs()));
  for (const patch of [{ assignTo: ['worker'] }, { type: 'code' }, { priority: 'critical' }, { command: 'node evil.js' }, { description: '\u0000' }, { tags: ['trading-organisation', '../escape'] }]) assert.throws(() => validateCall('task_create', { ...createArgs(), ...patch }));
  assert.throws(() => validateCall('task_status', { taskId: '../wallet' }));
  assert.throws(() => validateCall('task_complete', { taskId: 'task-1', result: { resultReference: 'local:result', outcome: 'completed', authority: 'ruflo' } }));
});

test('required fields and tool catalogue fail closed on contract drift', () => {
  assert.equal(verifyContracts(contracts()), true);
  assert.throws(() => verifyContracts([...contracts(), { name: 'agent_spawn' }]));
  const missing = contracts(); missing[0].inputSchema.required.push('command');
  assert.throws(() => verifyContracts(missing), /changed/);
  const changed = contracts(); changed[1].inputSchema.properties.taskId.type = 'number';
  assert.throws(() => verifyContracts(changed), /changed/);
});

test('child receives no application, model, proxy, shell-option or provider credentials', () => {
  const env = childEnvironment('/isolated', { SystemRoot: 'C:\\Windows', PRINCIPALS_JSON: 'secret', API_TOKEN: 'secret', ANTHROPIC_API_KEY: 'secret', OPENAI_API_KEY: 'secret', NODE_OPTIONS: '--import malicious.mjs', HTTP_PROXY: 'secret', PATH: 'malicious-bin' });
  for (const key of ['PRINCIPALS_JSON', 'API_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'NODE_OPTIONS', 'HTTP_PROXY']) assert.equal(env[key], undefined);
  assert.equal(env.CLAUDE_FLOW_MCP_TOOLS, ALLOWED_TOOLS.join(','));
  assert.notEqual(env.PATH, 'malicious-bin');
});

function memoryClient({ createError = false } = {}) {
  let count = 0;
  const tasks = new Map();
  return { calls: [], async call(name, args) {
    this.calls.push({ name, args });
    if (name === 'task_create') {
      if (createError) throw new Error('timeout');
      const taskId = `task-${++count}`;
      const result = { taskId, type: 'research', status: 'pending', assignedTo: [] };
      tasks.set(taskId, result); return result;
    }
    if (name === 'task_status') return tasks.get(args.taskId);
    if (name === 'task_complete') { const previous = tasks.get(args.taskId); if(previous.status === 'completed')return previous; const result = { ...previous, status: 'completed', result: args.result }; tasks.set(args.taskId, result); return result; }
  }, async close() {} };
}

test('concurrent duplicate registration is one record; completion cannot be changed', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'ruflo-coordinator-test-'));
  const client = memoryClient();
  const coordinator = new RufloCoordinator(client, await TaskJournal.open(stateDir));
  try {
    const tasks = await Promise.all([coordinator.createResearchTask('exp1', 'summary'), coordinator.createResearchTask('exp1', 'summary')]);
    assert.equal(tasks[0].taskId, tasks[1].taskId);
    assert.equal(client.calls.filter(c => c.name === 'task_create').length, 1);
    await assert.rejects(coordinator.createResearchTask('exp1', 'different'), /different summary/);
    await assert.rejects(coordinator.getResearchTask('someone-elses-task'), /not owned/);
    const result = { resultReference: 'application:exp1/result', outcome: 'completed' };
    await coordinator.completeResearchTask('exp1', result);
    assert.equal((await coordinator.completeResearchTask('exp1', result)).reused, true);
    await assert.rejects(coordinator.completeResearchTask('exp1', { ...result, outcome: 'failed' }), /differs/);
  } finally { await coordinator.close(); }
  const reopened = new RufloCoordinator(client, await TaskJournal.open(stateDir));
  try { assert.equal((await reopened.createResearchTask('exp1', 'summary')).reused, true); } finally { await reopened.close(); }
});

test('unknown create result survives restart and forbids blind duplication', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'ruflo-uncertainty-test-'));
  const failing = new RufloCoordinator(memoryClient({ createError: true }), await TaskJournal.open(stateDir));
  await assert.rejects(failing.createResearchTask('exp1', 'summary'), /timeout/);
  await failing.close();
  const client = memoryClient();
  const reopened = new RufloCoordinator(client, await TaskJournal.open(stateDir));
  try {
    await assert.rejects(reopened.createResearchTask('exp1', 'summary'), /unknown outcome/);
    assert.equal(client.calls.length, 0);
    assert.match(await readFile(join(stateDir, 'coordination.jsonl'), 'utf8'), /create_requested/);
  } finally { await reopened.close(); }
});

test('exclusive journal lock rejects a second coordinator', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'ruflo-lock-test-'));
  const journal = await TaskJournal.open(stateDir);
  try { await assert.rejects(TaskJournal.open(stateDir), /locked/); } finally { await journal.close(); }
});

test('lost completion acknowledgement preserves its result across restart and forbids a changed result', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'ruflo-completion-retry-'));
  const storage = memoryClient(); let lost = false;
  const client = { async call(name, args) { const result = await storage.call(name, args); if(name === 'task_complete' && !lost) { lost = true; throw new Error('Lost acknowledgement'); } return result; }, async close() {} };
  let coordinator = new RufloCoordinator(client, await TaskJournal.open(stateDir));
  const completion = { resultReference:'experiment:exp1', outcome:'completed' };
  await coordinator.createResearchTask('exp1','summary');
  await assert.rejects(coordinator.completeResearchTask('exp1',completion),/Lost acknowledgement/);
  await coordinator.close();
  coordinator = new RufloCoordinator(client, await TaskJournal.open(stateDir));
  try {
    const count = storage.calls.length;
    await assert.rejects(coordinator.completeResearchTask('exp1',{...completion,outcome:'rejected'}),/differs/);
    assert.equal(storage.calls.length,count);
    assert.equal((await coordinator.completeResearchTask('exp1',completion)).status,'completed');
    assert.equal((await coordinator.completeResearchTask('exp1',completion)).reused,true);
  }finally{await coordinator.close();}
});

test('upstream cannot acknowledge a different result as successful', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'ruflo-result-mismatch-'));
  const storage = memoryClient();
  const client = { async call(name,args) { const value=await storage.call(name,args); return name==='task_complete'?{...value,result:{...args.result,outcome:'rejected'}}:value; }, async close() {} };
  const coordinator = new RufloCoordinator(client,await TaskJournal.open(stateDir));
  try {
    await coordinator.createResearchTask('exp1','summary');
    await assert.rejects(coordinator.completeResearchTask('exp1',{resultReference:'experiment:exp1',outcome:'completed'}),/differs/);
    const events=(await readFile(join(stateDir,'coordination.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(events.at(-1).kind,'completion_requested');
  }finally{await coordinator.close();}
});

function fakeChild(mode = 'normal') {
  const child = new EventEmitter(); child.pid = 1234; child.exitCode = null; child.signalCode = null;
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.messages = [];
  child.kill = () => { if (child.signalCode === null) { child.signalCode = 'SIGTERM'; queueMicrotask(() => child.emit('exit', null, 'SIGTERM')); } };
  child.stdin = new Writable({ write(chunk, encoding, callback) {
    const message = JSON.parse(chunk.toString()); child.messages.push(message);
    callback();
    if (mode === 'timeout' || message.id === undefined || !message.method) return;
    queueMicrotask(() => {
      if (mode === 'malformed') { child.stdout.write('invalid\n'); return; }
      let result;
      if (message.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: 'test' } };
      else if (message.method === 'tools/list') result = { tools: contracts() };
      else result = { content: [{ type: 'text', text: JSON.stringify({ taskId: 'task-1', status: 'pending' }) }] };
      child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
    });
  }, final(callback) { callback(); child.kill(); } });
  return child;
}

test('MCP performs initialization, schema negotiation, and only allowlisted calls', async () => {
  const child = fakeChild(); const client = new StdioMcpClient(child);
  try {
    await client.initialize();
    await assert.rejects(client.call('agent_spawn', {}), /denied/);
    assert.equal((await client.call('task_status', { taskId: 'task-1' })).status, 'pending');
    assert.deepEqual(child.messages.filter(m => m.method === 'tools/call').map(m => m.params.name), ['task_status']);
  } finally { await client.close(); }
});

test('MCP rejects malformed output and kills timeout sessions', async () => {
  for (const mode of ['malformed', 'timeout']) {
    const child = fakeChild(mode); const client = new StdioMcpClient(child, { timeoutMs: 100 });
    await assert.rejects(client.initialize(), mode === 'timeout' ? /timed out/ : /Malformed/);
    assert.equal(child.signalCode, 'SIGTERM');
    await client.close();
  }
});
