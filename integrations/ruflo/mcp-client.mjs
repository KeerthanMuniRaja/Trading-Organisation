import { once } from 'node:events';

export const ALLOWED_TOOLS = Object.freeze(['task_create', 'task_status', 'task_complete']);
export const EXPECTED_CONTRACTS = Object.freeze({
  task_create: { required: ['type', 'description'], properties: { type: 'string', description: 'string', priority: 'string', assignTo: 'array', tags: 'array' } },
  task_status: { required: ['taskId'], properties: { taskId: 'string' } },
  task_complete: { required: ['taskId'], properties: { taskId: 'string', result: 'object' } },
});

export function verifyContracts(tools) {
  if (!Array.isArray(tools) || tools.length !== ALLOWED_TOOLS.length) throw new Error('Unexpected Ruflo tool catalogue');
  for (const name of ALLOWED_TOOLS) {
    const matching = tools.filter(tool => tool.name === name);
    const schema = matching[0]?.inputSchema;
    const expected = EXPECTED_CONTRACTS[name];
    if (matching.length !== 1 || schema?.type !== 'object') throw new Error(`Missing contract: ${name}`);
    if (JSON.stringify([...(schema.required ?? [])].sort()) !== JSON.stringify([...expected.required].sort())) throw new Error(`Required fields changed: ${name}`);
    for (const [property, type] of Object.entries(expected.properties)) {
      if (schema.properties?.[property]?.type !== type) throw new Error(`Contract changed: ${name}.${property}`);
    }
    if (Object.keys(schema.properties).some(key => !(key in expected.properties))) throw new Error(`Unexpected contract field: ${name}`);
  }
  return true;
}

function exactKeys(object, keys) {
  return object && Object.getPrototypeOf(object) === Object.prototype && Object.keys(object).every(key => keys.includes(key));
}

export function validateCall(name, args) {
  if (!ALLOWED_TOOLS.includes(name)) throw new Error('Ruflo tool denied');
  const keys = Object.keys(EXPECTED_CONTRACTS[name].properties);
  if (!exactKeys(args, keys)) throw new Error('Unexpected Ruflo arguments');
  if (name === 'task_create') {
    if (args.type !== 'research' || args.priority !== 'normal' || args.assignTo?.length !== 0 || !Array.isArray(args.assignTo)) throw new Error('Only unassigned research records are permitted');
    if (typeof args.description !== 'string' || !args.description.trim() || args.description.length > 2400 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(args.description)) throw new Error('Invalid research description');
    if (!Array.isArray(args.tags) || args.tags.length !== 2 || args.tags[0] !== 'trading-organisation' || !/^experiment-[a-zA-Z0-9_-]{1,100}$/u.test(args.tags[1])) throw new Error('Invalid research tags');
  } else {
    if (typeof args.taskId !== 'string' || !/^task-[a-zA-Z0-9_-]{1,100}$/u.test(args.taskId)) throw new Error('Invalid Ruflo task ID');
    if (name === 'task_complete') {
      const result = args.result;
      if (!exactKeys(result, ['resultReference', 'outcome', 'authority']) || !['completed', 'rejected', 'failed'].includes(result.outcome) || result.authority !== 'application-owned') throw new Error('Invalid completion result');
      if (typeof result.resultReference !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:/_.-]{0,199}$/u.test(result.resultReference)) throw new Error('Invalid result reference');
    }
  }
}

export class StdioMcpClient {
  #child; #pending = new Map(); #buffer = ''; #received = 0; #sequence = 0; #closed = false; #timeout; #calls = 0;
  constructor(child, { timeoutMs = 15000 } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw new Error('Invalid MCP timeout');
    this.#child = child;
    this.#timeout = timeoutMs;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => this.#consume(chunk));
    // Drain diagnostics without forwarding source text or retaining unbounded logs.
    child.stderr.on('data', () => {});
    child.on('error', () => this.#abort(new Error('Ruflo child process failed')));
    child.on('exit', () => this.#abort(new Error('Ruflo child process exited')));
    child.stdin.on('error', () => this.#abort(new Error('Ruflo stdin failed')));
  }
  #consume(chunk) {
    this.#received += Buffer.byteLength(chunk);
    this.#buffer += chunk;
    if (this.#received > 2 * 1024 * 1024 || Buffer.byteLength(this.#buffer) > 512 * 1024) return this.#abort(new Error('Ruflo response budget exceeded'));
    while (this.#buffer.includes('\n')) {
      const index = this.#buffer.indexOf('\n');
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { return this.#abort(new Error('Malformed MCP stdout')); }
      if (message?.jsonrpc !== '2.0') return this.#abort(new Error('Invalid MCP envelope'));
      // No sampling, elicitation, filesystem roots, or other server-initiated services.
      if (message.method) {
        if (message.id !== undefined) this.#child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Client capability denied' } }) + '\n');
        continue;
      }
      const pending = this.#pending.get(message.id);
      if (!pending) return this.#abort(new Error('Unexpected MCP response ID'));
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      if (message.error || !('result' in message)) pending.reject(new Error(`Ruflo RPC rejected ${pending.method} (${Number(message.error?.code) || 'unknown'})`, {cause:message.error}));
      else pending.resolve(message.result);
    }
  }
  #abort(error) {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.#pending.clear();
    this.#child.kill();
  }
  #request(method, params = {}) {
    if (this.#closed) return Promise.reject(new Error('MCP client is closed'));
    if (++this.#calls > 64) return Promise.reject(new Error('MCP session request limit reached'));
    const id = ++this.#sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#abort(new Error('Ruflo request timed out; outcome may be unknown')), this.#timeout);
      this.#pending.set(id, { resolve, reject, timer, method });
      this.#child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async initialize() {
    const hello = await this.#request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'trading-organisation-coordinator', version: '0.1.0' } });
    if (hello?.protocolVersion !== '2024-11-05' || !hello.capabilities?.tools) throw new Error('Unsupported MCP handshake');
    this.#child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const catalogue = await this.#request('tools/list');
    verifyContracts(catalogue.tools);
    return { serverInfo: hello.serverInfo, tools: catalogue.tools };
  }
  async call(name, args) {
    validateCall(name, args);
    const envelope = await this.#request('tools/call', { name, arguments: args });
    if (envelope?.isError || !Array.isArray(envelope?.content) || envelope.content.length !== 1 || envelope.content[0].type !== 'text') throw new Error('Ruflo tool returned an error or unexpected content');
    let result;
    try { result = JSON.parse(envelope.content[0].text); } catch { throw new Error('Ruflo tool did not return JSON'); }
    if (!result || typeof result !== 'object' || result.error || result.success === false) throw new Error('Ruflo task operation failed');
    return result;
  }
  async close() {
    if (this.#child.exitCode !== null || this.#child.signalCode !== null || this.#child.pid === undefined) return;
    const exited = once(this.#child, 'exit').catch(() => {});
    this.#closed = true;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('MCP client closed')); }
    this.#pending.clear();
    this.#child.stdin.end();
    const timer = setTimeout(() => this.#child.kill(), 1000);
    await exited;
    clearTimeout(timer);
  }
}
