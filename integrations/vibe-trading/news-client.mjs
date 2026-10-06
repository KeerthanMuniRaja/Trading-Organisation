const PROTOCOL = '2025-03-26';
const MAX_BYTES = 300000;

export function validateCollector(config, query) {
  if (!config || config.enabled !== true || Object.keys(config).some(k => !['enabled', 'endpoint', 'timeoutMs'].includes(k)))
    throw new Error('Collector must be explicitly enabled with known configuration fields');
  const endpoint = new URL(config.endpoint);
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname) ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      !['/mcp', '/mcp/'].includes(endpoint.pathname)) throw new Error('Collector requires a literal loopback HTTP /mcp endpoint');
  const timeoutMs = config.timeoutMs ?? 15000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw new Error('Invalid collector timeout');
  if (!query || Object.keys(query).some(k => !['scope', 'code', 'limit'].includes(k)) ||
      !['stock', 'global'].includes(query.scope) || !Number.isInteger(query.limit) || query.limit < 1 || query.limit > 25)
    throw new Error('Provide a bounded stock or global news query');
  if (query.scope === 'stock' && (typeof query.code !== 'string' || !/^[A-Z0-9][A-Z0-9.-]{0,19}\.(US|HK|SH|SZ|BJ)$/.test(query.code)))
    throw new Error('Unsupported stock news symbol');
  if (query.scope === 'global' && query.code !== undefined) throw new Error('Global queries cannot include a symbol');
  return { endpoint: endpoint.href, timeoutMs, query: { scope: query.scope, limit: query.limit,
    ...(query.scope === 'stock' ? { code: query.code } : {}) } };
}

function rpcResult(value, id) {
  if (!value || Array.isArray(value) || value.jsonrpc !== '2.0' || value.id !== id ||
      'method' in value || 'error' in value || !Object.hasOwn(value, 'result'))
    throw new Error('Invalid MCP response');
  return value.result;
}

async function readResult(response, id) {
  const type = response.headers.get('content-type')?.split(';')[0].trim();
  if (!['application/json', 'text/event-stream'].includes(type)) {
    await response.body?.cancel();
    throw new Error('Unsupported MCP response type');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing MCP response body');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, buffer = '', events = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw new Error('MCP response capacity exceeded');
      buffer += decoder.decode(value, { stream: true });
      if (type === 'text/event-stream') {
        let match;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          const event = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          if (++events > 100) throw new Error('MCP event capacity exceeded');
          const data = event.split(/\r?\n/).filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).replace(/^ /, '')).join('\n');
          if (!data) continue;
          const message = JSON.parse(data);
          // We expose no sampling, file roots, elicitation or other client capabilities.
          if (message?.jsonrpc === '2.0' && typeof message.method === 'string' && !Object.hasOwn(message, 'id')) continue;
          return rpcResult(message, id);
        }
      }
    }
    buffer += decoder.decode();
    if (type === 'application/json') return rpcResult(JSON.parse(buffer), id);
    throw new Error('MCP stream ended without a response');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** One session, one hard-coded read-only tool, no retries or runtime installation. */
export async function collectNews(config, query, { transport = fetch, signal } = {}) {
  const options = validateCollector(config, query);
  const deadline = AbortSignal.timeout(options.timeoutMs);
  const boundedSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let session, initialized = false, cleanup = 'not-required';
  const headers = () => ({ Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json',
    ...(initialized ? { 'MCP-Protocol-Version': PROTOCOL } : {}), ...(session ? { 'Mcp-Session-Id': session } : {}) });
  const post = async body => {
    boundedSignal.throwIfAborted();
    const response = await transport(options.endpoint, { method: 'POST', redirect: 'error',
      headers: headers(), body: JSON.stringify(body), signal: boundedSignal });
    if (!response.ok) { await response.body?.cancel(); throw new Error('MCP request failed'); }
    return response;
  };
  let output;
  try {
    const response = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'organisation-news-collector', version: '1.0.0' } } });
    const candidate = response.headers.get('Mcp-Session-Id');
    if (candidate !== null) {
      if (!/^[\x21-\x7e]{1,256}$/.test(candidate)) { await response.body?.cancel(); throw new Error('Invalid MCP session'); }
      session = candidate;
    }
    const hello = await readResult(response, 1);
    if (hello?.protocolVersion !== PROTOCOL || !hello.capabilities?.tools ||
        hello.serverInfo?.name !== 'Vibe-Trading' || typeof hello.serverInfo.version !== 'string' ||
        hello.serverInfo.version.length > 100) throw new Error('Unexpected MCP server or protocol');
    initialized = true;
    const ready = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await ready.body?.cancel();
    if (ready.status !== 202) throw new Error('MCP initialization was not acknowledged');
    const answer = await readResult(await post({ jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'get_stock_news', arguments: options.query } }), 2);
    if (!answer || answer.isError || !Array.isArray(answer.content) || answer.content.length !== 1 ||
        answer.content[0]?.type !== 'text' || typeof answer.content[0].text !== 'string')
      throw new Error('Unexpected stock news tool result');
    const result = JSON.parse(answer.content[0].text);
    const suffix = options.query.code?.split('.').at(-1);
    const market = options.query.scope === 'global' ? 'global' : suffix === 'US' ? 'us' : suffix === 'HK' ? 'hk' : 'a_share';
    const provider = ['us', 'hk'].includes(market) ? 'yahoo' : 'eastmoney';
    if (result?.ok !== true || result.market !== market || result.source !== provider ||
        result.data?.scope !== options.query.scope ||
        (options.query.scope === 'stock' && result.data.code !== options.query.code) ||
        !Array.isArray(result.data.articles) || result.data.articles.length > options.query.limit)
      throw new Error('News result does not match the requested scope');
    output = { result, transport: { endpoint: options.endpoint, protocol: PROTOCOL,
      serverVersion: hello.serverInfo.version, collectedAt: new Date().toISOString(), tool: 'get_stock_news', query: options.query } };
  } catch {
    // Upstream exceptions and bodies must not be echoed into operator logs.
    throw new Error('News collection failed: no evidence was submitted');
  } finally {
    if (session) {
      try {
        const response = await transport(options.endpoint, { method: 'DELETE', redirect: 'error', headers: headers(),
          signal: AbortSignal.timeout(2000) });
        cleanup = response.ok ? 'closed' : response.status === 405 ? 'unsupported' : 'failed';
        await response.body?.cancel();
      } catch { cleanup = 'failed'; }
    }
  }
  return { ...output, cleanup };
}
