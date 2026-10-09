// Only the quote endpoint is exposed. This adapter cannot submit broker orders.
export class QuoteError extends Error {}
const fail = code => { throw new QuoteError(code); };
export function marketWindow(now) {
  const d = new Date(now + 330 * 60_000);
  const minute = d.getUTCHours() * 60 + d.getUTCMinutes();
  return d.getUTCDay() !== 0 && d.getUTCDay() !== 6 && minute >= 555 && minute < 930;
}
export function paise(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) fail('INVALID_PRICE');
  const n = Math.round(value * 100);
  if (!Number.isSafeInteger(n) || n > 100_000_000 || Math.abs(value * 100 - n) > 0.00001) fail('INVALID_PRICE');
  return n;
}
export function normalizeQuote(payload, now, previousTime = 0) {
  const q = payload?.status === 'success' && payload.data?.['NSE:RELIANCE'];
  if (!q || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(q.timestamp)) fail('INVALID_QUOTE');
  const time = Date.parse(q.timestamp.replace(' ', 'T') + '+05:30');
  if (!Number.isFinite(time) || new Date(time + 330 * 60_000).toISOString().slice(0, 19).replace('T', ' ') !== q.timestamp) fail('INVALID_TIMESTAMP');
  if (time > now + 2000 || now - time > 10_000) fail('STALE_OR_FUTURE_QUOTE');
  if (time <= previousTime) fail('NON_ADVANCING_QUOTE');
  if (!marketWindow(now) || !marketWindow(time)) fail('OUTSIDE_SESSION');
  const levels = side => {
    if (!Array.isArray(side) || side.length > 5) fail('INVALID_DEPTH');
    return side.filter(x => x && Number.isSafeInteger(x.quantity) && x.quantity > 0)
      .map(x => ({ price: paise(x.price), quantity: x.quantity }));
  };
  const buys = levels(q.depth?.buy).sort((a, b) => b.price - a.price);
  const sells = levels(q.depth?.sell).sort((a, b) => a.price - b.price);
  if (!buys.length || !sells.length || sells[0].price < buys[0].price) fail('INVALID_DEPTH');
  return { symbol: 'NSE:RELIANCE', time, observedAt: new Date(time).toISOString(),
    bidPaise: buys[0].price, askPaise: sells[0].price,
    bidQuantity: buys[0].quantity, askQuantity: sells[0].quantity };
}
export async function fetchQuote({ apiKey, accessToken, previousTime = 0, timeoutMs = 8000,
  fetchImpl = fetch, now = Date.now }) {
  if (![apiKey, accessToken].every(x => typeof x === 'string' && /^[A-Za-z0-9_-]{4,256}$/.test(x))) fail('KITE_CREDENTIALS_REQUIRED');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl('https://api.kite.trade/quote?i=NSE%3ARELIANCE', {
      method: 'GET', redirect: 'error', signal: controller.signal,
      headers: { 'X-Kite-Version': '3', Authorization: `token ${apiKey}:${accessToken}` }
    });
    if (!response.ok) fail(response.status === 401 || response.status === 403 ? 'KITE_ACCESS_DENIED' : 'QUOTE_HTTP_FAILED');
    if (!response.body) fail('EMPTY_RESPONSE');
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 65536) { await reader.cancel(); fail('RESPONSE_TOO_LARGE'); }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    let payload;
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('INVALID_JSON'); }
    return normalizeQuote(payload, now(), previousTime);
  } catch (error) {
    if (error instanceof QuoteError) throw error;
    fail(controller.signal.aborted ? 'QUOTE_TIMEOUT' : 'QUOTE_REQUEST_FAILED');
  } finally { clearTimeout(timer); }
}
