import { createHash } from 'node:crypto';
import { observationKey, parseSourceMappings, validateBatch } from '../../scripts/import-observations.mjs';

// Bounded RSS 2.0 / Atom 1.0 reader. Feed text is untrusted data: no DTDs, external entities,
// network lookups or markup execution. Only a small, well-formed XML subset is accepted.
export const MAX_FEED_BYTES = 1048576;
const MAX_DEPTH = 32, MAX_ELEMENTS = 20000, MAX_ATTRIBUTES = 32, MAX_ITEMS = 100;
const NAME = /^[A-Za-z_][\w.:-]{0,127}$/;
const XML_REFERENCE = /&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|lt|gt|amp|quot|apos);/g;
const NAMED = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export class FeedFormatError extends Error {}
const fail = message => { throw new FeedFormatError(message); };

function codePoint(value) {
  const point = value[1] === 'x' || value[1] === 'X' ? parseInt(value.slice(2), 16) : parseInt(value.slice(1), 10);
  const valid = point === 0x9 || point === 0xa || point === 0xd || (point >= 0x20 && point <= 0xd7ff) ||
    (point >= 0xe000 && point <= 0xfffd) || (point >= 0x10000 && point <= 0x10ffff);
  if (!valid) fail('Invalid character reference');
  return String.fromCodePoint(point);
}
function decodeXml(value) {
  // Without a DTD, only the five predefined entities and character references are well-formed.
  if (value.replace(XML_REFERENCE, '').includes('&')) fail('Undeclared or malformed entity reference');
  return value.replace(XML_REFERENCE, (_, ref) => ref[0] === '#' ? codePoint(ref) : NAMED[ref]);
}
function tagEnd(text, from) {
  let quote = null;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote) quote = null; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === '<') fail('Unexpected markup inside tag');
    else if (c === '>') return i;
  }
  fail('Unterminated tag');
}
function parseTag(body) {
  const selfClosing = body.endsWith('/');
  const inner = selfClosing ? body.slice(0, -1) : body;
  const name = /^[^\s]+/.exec(inner)?.[0] ?? '';
  if (!NAME.test(name)) fail('Invalid element name');
  const attrs = {};
  let rest = inner.slice(name.length), count = 0;
  const attribute = /^\s+([A-Za-z_][\w.:-]{0,127})\s*=\s*(?:"([^"]*)"|'([^']*)')/;
  for (let match; (match = attribute.exec(rest));) {
    if (Object.hasOwn(attrs, match[1]) || ++count > MAX_ATTRIBUTES) fail('Duplicate or excessive attributes');
    attrs[match[1]] = decodeXml(match[2] ?? match[3]);
    rest = rest.slice(match[0].length);
  }
  if (rest.trim()) fail('Malformed attributes');
  return { name, attrs, selfClosing };
}

export function parseXml(input) {
  let text = input;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]/.test(text)) fail('Control characters are not permitted');
  const document = { name: '#document', attrs: {}, children: [], nodes: [], text: '' };
  const stack = [document];
  let i = 0, elements = 0;
  const appendText = value => { const top = stack.at(-1); top.text += value; top.nodes.push(value); };
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    const chunk = lt === -1 ? text.slice(i) : text.slice(i, lt);
    if (chunk) appendText(decodeXml(chunk));
    if (lt === -1) break;
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4); if (end < 0) fail('Unterminated comment'); i = end + 3; continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      if (stack.length < 2) fail('Character data outside the root element');
      const end = text.indexOf(']]>', lt + 9); if (end < 0) fail('Unterminated CDATA');
      appendText(text.slice(lt + 9, end)); i = end + 3; continue;
    }
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2); if (end < 0) fail('Unterminated processing instruction');
      const declaration = text.slice(lt + 2, end);
      const encoding = /^xml\s[^]*?encoding\s*=\s*["']([^"']+)["']/.exec(declaration)?.[1];
      if (encoding && !/^utf-?8$/i.test(encoding)) fail('Only UTF-8 feeds are supported');
      i = end + 2; continue;
    }
    // DOCTYPE, ENTITY and other declarations are refused outright: no entity expansion is possible.
    if (text.startsWith('<!', lt)) fail('Document type and entity declarations are not accepted');
    const end = tagEnd(text, lt + 1);
    const body = text.slice(lt + 1, end);
    if (body.startsWith('/')) {
      const name = body.slice(1).trim();
      if (stack.length < 2 || stack.at(-1).name !== name) fail('Mismatched closing tag');
      stack.pop();
    } else {
      const tag = parseTag(body);
      if (stack.length === 1 && document.children.length) fail('Multiple root elements');
      if (++elements > MAX_ELEMENTS) fail('Element capacity exceeded');
      const element = { name: tag.name, attrs: tag.attrs, children: [], nodes: [], text: '' };
      stack.at(-1).children.push(element);
      stack.at(-1).nodes.push(element);
      if (!tag.selfClosing) {
        stack.push(element);
        if (stack.length - 1 > MAX_DEPTH) fail('Nesting depth exceeded');
      }
    }
    i = end + 1;
  }
  if (stack.length !== 1) fail('Unclosed element');
  if (document.children.length !== 1 || document.text.trim()) fail('Exactly one root element is required');
  return document.children[0];
}

const local = name => name.slice(name.indexOf(':') + 1);
// Mixed content keeps document order; element boundaries become word breaks.
const textContent = element => element.nodes.map(n => typeof n === 'string' ? n : ' ' + textContent(n) + ' ').join('');
const NAMED_HTML = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
/** Reduces publisher HTML to plain text. The result is still untrusted data, never rendered or executed. */
export function htmlToText(html) {
  return html
    .replace(/<(script|style)\b[^]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,8}|#39);/g, (whole, ref) => {
      if (Object.hasOwn(NAMED_HTML, ref)) return NAMED_HTML[ref];
      if (ref[0] !== '#') return whole;
      try { return codePoint(ref); } catch { return ' '; }
    })
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n[\s]*/g, '\n')
    .trim();
}

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
function utc(year, month, day, hour, minute, second, offsetMinutes) {
  if (hour > 23 || minute > 59 || second > 59) return null;
  const value = Date.UTC(year, month, day, hour, minute, second);
  const check = new Date(value);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month || check.getUTCDate() !== day) return null;
  return value - offsetMinutes * 60000;
}
/** RFC 822 (RSS) or RFC 3339 (Atom) with an explicit zone. Unzoned or named local zones are not guessed. */
export function parseFeedDate(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().replace(/\s+/g, ' ');
  let m = /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), )?(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2})(?::(\d{2}))? (GMT|UTC|UT|Z|[+-]\d{4})$/.exec(value);
  if (m) {
    const zone = m[7], offset = /^[+-]/.test(zone)
      ? (zone[0] === '-' ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3))) : 0;
    if (/^[+-]/.test(zone) && (Number(zone.slice(1, 3)) > 14 || Number(zone.slice(3)) > 59)) return null;
    return utc(Number(m[3]), MONTHS[m[2]], Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0), offset);
  }
  m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (m) {
    const zone = m[7], offset = zone === 'Z' ? 0
      : (zone[0] === '-' ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4)));
    if (zone !== 'Z' && (Number(zone.slice(1, 3)) > 14 || Number(zone.slice(4)) > 59)) return null;
    return utc(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), offset);
  }
  return null;
}

function atomText(element) {
  if (!element) return '';
  const type = element.attrs.type ?? 'text';
  if (type === 'xhtml') return textContent(element).replace(/\s+/g, ' ').trim();
  if (type === 'html') return htmlToText(element.text);
  return element.text.replace(/\s+/g, ' ').trim();
}
/** Extracts raw entries in document order. Field values remain untrusted and unvalidated. */
export function extractEntries(root) {
  if (root.name === 'rss') {
    const channels = root.children.filter(c => c.name === 'channel');
    if (channels.length !== 1) fail('RSS requires exactly one channel');
    const items = channels[0].children.filter(c => c.name === 'item');
    const field = (item, name) => item.children.find(c => c.name === name);
    return { format: 'rss-2.0', truncated: items.length > MAX_ITEMS, entries: items.slice(0, MAX_ITEMS).map(item => ({
      title: htmlToText(field(item, 'title')?.text ?? ''),
      link: (field(item, 'link')?.text ?? '').trim(),
      summary: htmlToText(field(item, 'description')?.text ?? ''),
      published: (field(item, 'pubDate') ?? field(item, 'dc:date'))?.text ?? null,
    })) };
  }
  if (local(root.name) === 'feed') {
    const entries = root.children.filter(c => local(c.name) === 'entry');
    const field = (entry, name) => entry.children.find(c => local(c.name) === name);
    return { format: 'atom-1.0', truncated: entries.length > MAX_ITEMS, entries: entries.slice(0, MAX_ITEMS).map(entry => {
      const links = entry.children.filter(c => local(c.name) === 'link');
      const link = links.find(l => (l.attrs.rel ?? 'alternate') === 'alternate') ?? null;
      return {
        title: atomText(field(entry, 'title')),
        link: (link?.attrs.href ?? '').trim(),
        summary: atomText(field(entry, 'summary')) || atomText(field(entry, 'content')),
        published: (field(entry, 'published') ?? field(entry, 'updated'))?.text ?? null,
      };
    }) };
  }
  fail('Unsupported feed format; RSS 2.0 or Atom 1.0 required');
}

const SUMMARY_LABEL = 'Feed summary (not the full article):\n';
const TRUNCATION = '\n[Summary truncated by collector]';
const REASONS = new Set(['Missing or invalid article link', 'Article link must be HTTPS without credentials',
  'Article origin has no source mapping', 'Title and nonempty summary required',
  'An explicit-zone publication timestamp is required', 'Publication time is after retrieval',
  'Duplicate entry in feed']);

/**
 * Offline conversion of saved feed bytes into observation rows. `fetchedAt` is the recorded retrieval time,
 * so preparing the same saved bytes later yields identical rows.
 */
export function prepareFeed(bytes, feed, fetchedAt) {
  if (!Number.isFinite(fetchedAt)) throw new Error('Invalid retrieval time');
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_FEED_BYTES) throw new FeedFormatError('Feed exceeds size limit');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('Feed is not valid UTF-8'); }
  const sources = parseSourceMappings({ sources: feed.sources });
  const { format, entries, truncated } = extractEntries(parseXml(text));
  const observations = [], rejected = [], seen = new Set();
  for (const [index, entry] of entries.entries()) {
    try {
      let url;
      try { url = new URL(entry.link, feed.feedUrl); } catch { throw new Error('Missing or invalid article link'); }
      if (!entry.link) throw new Error('Missing or invalid article link');
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Article link must be HTTPS without credentials');
      url.hash = '';
      const sourceId = sources.get(url.origin);
      if (!sourceId) throw new Error('Article origin has no source mapping');
      const title = entry.title.replace(/\s+/g, ' ').trim();
      if (!title || !entry.summary) throw new Error('Title and nonempty summary required');
      const published = parseFeedDate(entry.published);
      if (published === null) throw new Error('An explicit-zone publication timestamp is required');
      if (published > fetchedAt) throw new Error('Publication time is after retrieval');
      const room = 4000 - SUMMARY_LABEL.length;
      const summary = entry.summary.length > room ? entry.summary.slice(0, room - TRUNCATION.length) + TRUNCATION : entry.summary;
      const row = validateBatch([{ sourceId, url: url.href, title: title.length > 300 ? title.slice(0, 297) + '...' : title,
        kind: feed.kind, content: SUMMARY_LABEL + summary, publishedAt: new Date(published).toISOString() }])[0];
      const key = observationKey(row);
      if (seen.has(key)) throw new Error('Duplicate entry in feed');
      seen.add(key);
      observations.push(row);
    } catch (error) {
      // Diagnostics never echo publisher text or URLs.
      rejected.push({ index, reason: REASONS.has(error.message) ? error.message : 'Invalid entry fields' });
    }
  }
  return { format, observations, rejected, truncated, provenance: { adapter: 'publisher-feed-v1', feedUrl: feed.feedUrl,
    rawHash: createHash('sha256').update(bytes).digest('hex'), scope: 'collector-submitted-feed-summaries' }, reviewRequired: true };
}
