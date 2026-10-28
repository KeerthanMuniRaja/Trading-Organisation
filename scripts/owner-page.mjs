// The owner's page (OVERSIGHT-02): the status screen as a local, self-contained web page of tiles. View-only and
// laptop-only (a file, no server, nothing published): the safe default until the owner decides the dashboard's tabs,
// look and reach (founder review B19-B22). It regroups exactly the lines `npm run status` prints, so the two can never
// disagree. The cycle rewrites it after the digest; open .local/owner-page.html in a browser.
//   npm run page
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gather, render } from './status.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const TILES = [
  ['Needs you', ['Needs you', 'Agenda']],
  ['Organisation', ['Backend', 'Supervisor', 'Cycle', 'Next', 'Autonomy']],
  ['Members and money', ['Members', 'Money']],
  ['Market', ['Regime', 'Sectors', 'Pulse', 'World', 'Intraday']],
  ['Research and predictions', ['Research', 'R&D', 'Forward', 'TradingAgents', 'Knowledge']],
  ['Models', ['Models']],
];

/** Status lines -> {tile: [lines]}. A line's label is its first word(s) before the column gap; indented lines and
 *  "- " items belong to the label above them (the members under "Members", the items under "Needs you"). */
export function toTiles(lines) {
  const byLabel = {}, labels = TILES.flatMap(([, ls]) => ls);
  let current = null;
  for (const raw of lines.slice(1)) {
    if (!raw.trim()) continue;
    const label = labels.find(l => raw === l || raw.startsWith(l + ' '));
    if (label && !raw.startsWith(' ')) {
      current = label;
      const rest = raw.slice(label.length).trim();
      (byLabel[label] ??= []).push(...(rest ? [rest] : []));
    } else if (current) (byLabel[current] ??= []).push(raw.trim().replace(/^- /, ''));
  }
  return TILES.map(([title, ls]) => [title, ls.flatMap(l => (byLabel[l] ?? []).map(text => ({ label: l, text })))]).filter(([, items]) => items.length);
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ALARM = /DOWN|STUCK|NOT RUNNING|HALTED|(?<!no )failed\b|UNEXPLAINED|warning/;   // "no failed steps" is good news

export function html(tiles, title, generatedAt) {
  const cards = tiles.map(([name, items]) => `<section class="card${name === 'Needs you' ? ' needs' : ''}"><h2>${esc(name)}</h2><ul>`
    + items.map(i => `<li${ALARM.test(i.text) ? ' class="alarm"' : ''}><span class="label">${esc(i.label)}</span> ${esc(i.text)}</li>`).join('')
    + '</ul></section>').join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trading organisation</title>
<style>
:root { --bg: #f6f7f9; --card: #ffffff; --text: #1d2430; --muted: #5b6573; --line: #dde2e8; --alarm: #b42318; --needs: #fff4e5; }
@media (prefers-color-scheme: dark) { :root { --bg: #12161c; --card: #1b212a; --text: #e6e9ee; --muted: #9aa4b2; --line: #2c3440; --alarm: #ff8a80; --needs: #2a2216; } }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
header { padding: 16px; } h1 { margin: 0; font-size: 20px; } header p { margin: 4px 0 0; color: var(--muted); }
main { display: grid; gap: 12px; padding: 0 16px 16px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 380px), 1fr)); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
.card.needs { background: var(--needs); } h2 { margin: 0 0 8px; font-size: 15px; }
ul { margin: 0; padding: 0; list-style: none; } li { padding: 4px 0; border-top: 1px solid var(--line); overflow-wrap: anywhere; } li:first-child { border-top: 0; }
.label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .03em; margin-right: 4px; }
li.alarm { color: var(--alarm); }
</style></head><body><header><h1>${esc(title)}</h1><p>View-only. Generated ${esc(generatedAt)} from the same facts as <code>npm run status</code>.</p></header>
<main>
${cards}
</main></body></html>
`;
}

async function main() {
  const facts = await gather();
  const lines = render(facts);
  const page = html(toTiles(lines), lines[0], new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC');
  const out = join(ROOT, '.local', 'owner-page.html');
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, page);
  console.log(JSON.stringify({ written: out }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
