import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, openSync, readFileSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';

// Pinned local model runtime. Every artifact is verified against config/local-model.lock.json before use.
const root = fileURLToPath(new URL('../', import.meta.url));
const lock = JSON.parse(readFileSync(join(root, 'config', 'local-model.lock.json'), 'utf8'));
const home = join(root, '.local', 'models');
const runtimeDir = join(home, 'llama.cpp-' + lock.runtime.release);
const server = join(runtimeDir, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');

// Machine-local files (never committed): what was measured and resolved on THIS machine.
//   pins.json     artifacts not in the lock (the Vulkan runtime, the decision model), each pinned to the hash its
//                 official source publishes (GitHub's release digest, Hugging Face's LFS sha256) when first resolved
//   tuning.json   the runtime and thread counts llama-bench measured fastest here (model-tune.mjs)
//   routing.json  the decision model, written only after it passed our exams (model-upgrade.mjs)
export const PINS = join(home, 'pins.json'), TUNING = join(home, 'tuning.json'), ROUTING = join(home, 'routing.json');
const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
export const vulkanDir = join(home, 'llama.cpp-' + lock.runtime.release + '-vulkan');
export const runtimeExe = (dir, tool) => join(dir, process.platform === 'win32' ? tool + '.exe' : tool);

const artifact = name => {
  if (name === 'runtime') return { file: lock.runtime.asset, url: lock.runtime.url, sha256: lock.runtime.sha256, bytes: lock.runtime.bytes };
  const m = lock.models[name];
  if (m) return { file: m.file, url: `https://huggingface.co/${m.repository}/resolve/${m.commit}/${m.file}`, sha256: m.sha256, bytes: m.bytes };
  const pinned = (readJson(PINS) ?? {})[name];
  if (pinned) return pinned;
  throw new Error(`Unknown artifact ${name}: resolve it first (local-model.mjs resolve ${name})`);
};

/** The decision model to try on a machine with this much RAM: the largest candidate that fits, in lock order. */
export function pickCandidate(candidates, ramBytes) {
  const gb = ramBytes / 2 ** 30;
  return candidates.filter(c => gb >= c.minRamGB).sort((a, b) => b.minRamGB - a.minRamGB);
}

/** A pin from GitHub's release listing: only an asset carrying a sha256 digest is accepted. */
export function pinFromRelease(release, asset) {
  const a = (release?.assets ?? []).find(x => x.name === asset);
  if (!a) throw new Error(`Release ${release?.tag_name} has no ${asset}`);
  const digest = /^sha256:([0-9a-f]{64})$/.exec(a.digest ?? '');
  if (!digest) throw new Error(`${asset} has no published sha256 digest; refusing an unverified download`);
  return { file: asset, url: a.browser_download_url, sha256: digest[1], bytes: a.size, source: 'github-release-digest' };
}

/** A pin from Hugging Face's file listing at an exact commit: the LFS sha256 and size it publishes. */
export function pinFromTree(repository, commit, tree, file) {
  const entry = (tree ?? []).find(x => x.path === file);
  if (!entry?.lfs?.oid || !/^[0-9a-f]{64}$/.test(entry.lfs.oid)) throw new Error(`${repository} has no LFS hash for ${file}`);
  return { file, url: `https://huggingface.co/${repository}/resolve/${commit}/${file}`, sha256: entry.lfs.oid, bytes: entry.lfs.size,
    source: 'huggingface-lfs-sha256', repository, commit };
}

async function savePin(name, pin) {
  const pins = readJson(PINS) ?? {};
  pins[name] = { ...pin, pinnedAt: new Date().toISOString() };
  await mkdir(home, { recursive: true });
  await writeFile(PINS, JSON.stringify(pins, null, 2) + '\n');
  return pins[name];
}

/** Resolves an artifact the lock does not pin: 'runtime-vulkan', or 'decision' (the largest candidate this RAM fits
 *  that its repository actually has). Network: GitHub's or Hugging Face's public API only. */
async function resolveArtifact(name, { fetchImpl = fetch, ram = totalmem() } = {}) {
  const get = async url => { const r = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) }); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.json(); };
  if (name === 'runtime-vulkan') {
    const release = await get(`https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/${lock.runtime.release}`);
    return savePin(name, pinFromRelease(release, lock.runtimeVulkan.asset));
  }
  if (name === 'decision') {
    const tried = [];
    for (const c of pickCandidate(lock.upgradeCandidates, ram)) {
      try {
        const info = await get(`https://huggingface.co/api/models/${c.repository}`);
        const tree = await get(`https://huggingface.co/api/models/${c.repository}/tree/${info.sha}`);
        return savePin(name, { ...pinFromTree(c.repository, info.sha, tree, c.file), key: c.key, alias: c.alias, baseModel: c.baseModel, license: c.license });
      } catch (error) { tried.push(`${c.key}: ${error.message}`); }
    }
    throw new Error(`No decision model fits ${Math.round(ram / 2 ** 30)} GB of RAM or could be resolved (${tried.join('; ') || 'none fits'})`);
  }
  throw new Error('Resolve one of: runtime-vulkan, decision');
}

async function hashFile(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/** Downloads to a .part file, hashing while streaming; only an exact size and SHA-256 match is kept. */
async function download(name) {
  const item = artifact(name), target = join(home, item.file);
  await mkdir(home, { recursive: true });
  if (existsSync(target)) {
    if ((await stat(target)).size === item.bytes && await hashFile(target) === item.sha256) return { name, file: item.file, state: 'verified-existing' };
    throw new Error(`${item.file} exists but does not match the lock; inspect or remove it manually`);
  }
  const part = target + '.part';
  await rm(part, { force: true });
  const response = await fetch(item.url, { signal: AbortSignal.timeout(6 * 3600 * 1000) });
  if (!response.ok || !response.body) throw new Error(`Download failed for ${item.file}: HTTP ${response.status}`);
  const hash = createHash('sha256');
  let bytes = 0, lastReport = 0;
  const meter = new Transform({ transform(chunk, _encoding, done) {
    bytes += chunk.length; hash.update(chunk);
    if (bytes > item.bytes) return done(new Error('Download exceeds the locked size'));
    if (bytes - lastReport > 256 * 1024 * 1024) { lastReport = bytes; console.error(`${item.file}: ${(bytes / 1e9).toFixed(2)} / ${(item.bytes / 1e9).toFixed(2)} GB`); }
    done(null, chunk);
  } });
  try { await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(part, { flags: 'wx' })); }
  catch (error) { await rm(part, { force: true }); throw error; }
  const digest = hash.digest('hex');
  if (bytes !== item.bytes || digest !== item.sha256) { await rm(part, { force: true }); throw new Error(`${item.file} failed verification; the download was deleted`); }
  await rename(part, target);
  return { name, file: item.file, state: 'downloaded-verified', bytes };
}

async function install(name) {
  if (name === 'runtime' || name === 'runtime-vulkan') {
    const result = await download(name);
    const dir = name === 'runtime' ? runtimeDir : vulkanDir, exe = runtimeExe(dir, 'llama-server');
    if (!existsSync(exe)) {
      await mkdir(dir, { recursive: true });
      // Windows 10+ ships bsdtar, which extracts zip archives without a third-party tool.
      const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
      const extracted = spawnSync(tar, ['-xf', join(home, artifact(name).file), '-C', dir], { windowsHide: true });
      if (extracted.status !== 0 || !existsSync(exe)) throw new Error('Runtime archive could not be extracted');
    }
    return { ...result, server: 'installed' };
  }
  return download(name);
}

/** The server's command line from the lock's server settings. `threads` / `threadsBatch` (generation / prompt
 *  reading) and `gpuLayers` are set only when measured on this machine (tuning.json); otherwise llama.cpp's default. */
export function serverArgs(s, weights, alias) {
  return ['-m', weights, '--alias', alias, '--host', s.host, '--port', String(s.port), '-c', String(s.contextTokens), '--parallel', String(s.parallel),
    ...(s.threads ? ['-t', String(s.threads)] : []), ...(s.threadsBatch ? ['-tb', String(s.threadsBatch)] : []),
    ...(s.gpuLayers ? ['-ngl', String(s.gpuLayers)] : []),
    '--jinja', '--reasoning', s.reasoning, '--reasoning-format', 'deepseek', '--no-webui'];
}

/** What serve uses on this machine: the lock's settings, this machine's measured tuning, and for the decision model
 *  its own port. The Vulkan runtime is used only if tuning chose it and it is installed. */
export function machineServer(lockServer, tuning, { decision = false, decisionPort = 8081, vulkanInstalled = false } = {}) {
  const vulkan = tuning?.runtime === 'vulkan' && vulkanInstalled;
  return { settings: { ...lockServer, ...(decision ? { port: decisionPort } : {}),
    ...(tuning?.threads ? { threads: tuning.threads } : {}), ...(tuning?.threadsBatch ? { threadsBatch: tuning.threadsBatch } : {}),
    ...(vulkan && tuning?.gpuLayers ? { gpuLayers: tuning.gpuLayers } : {}) }, runtime: vulkan ? 'vulkan' : 'cpu' };
}

function serve(name) {
  const decision = name === 'decision';
  const model = decision ? (readJson(PINS) ?? {}).decision : lock.models[name];
  if (!model) throw new Error(decision ? 'No decision model installed (model-upgrade.mjs)' : 'Unknown model key: ' + name);
  const weights = join(home, model.file);
  const { settings, runtime } = machineServer(lock.server, readJson(TUNING), { decision, decisionPort: lock.decisionServer.port,
    vulkanInstalled: existsSync(runtimeExe(vulkanDir, 'llama-server')) });
  const exe = runtime === 'vulkan' ? runtimeExe(vulkanDir, 'llama-server') : server;
  if (!existsSync(exe) || !existsSync(weights)) throw new Error('Install the runtime and model first');
  const key = process.env.HERMES_MODEL_API_KEY;
  if (!key) throw new Error('HERMES_MODEL_API_KEY is required; run configure first');
  const args = serverArgs(settings, weights, model.alias);
  const log = openSync(join(home, `server-${name}.log`), 'a');
  // The key travels through the environment (LLAMA_API_KEY), never the visible command line.
  const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
  const child = spawn(server, args, { cwd: runtimeDir, env: { ...env, LLAMA_API_KEY: key }, windowsHide: true, stdio: ['ignore', log, log] });
  console.log(JSON.stringify({ state: 'started', model: model.alias, endpoint: `http://${s.host}:${s.port}/v1`, pid: child.pid,
    log: `.local/models/server-${name}.log` }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill());
  child.once('exit', code => { console.log(JSON.stringify({ state: 'stopped', code })); process.exitCode = code ?? 1; });
}

/** Adds or replaces only the three model settings in the private .env; never prints the key. */
async function configure(name) {
  const model = lock.models[name];
  if (!model) throw new Error('Unknown model key: ' + name);
  const path = join(root, '.env');
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : [];
  const existingKey = lines.find(l => l.startsWith('HERMES_MODEL_API_KEY='))?.slice('HERMES_MODEL_API_KEY='.length);
  const values = { HERMES_MODEL: model.alias, HERMES_MODEL_BASE_URL: `http://${lock.server.host}:${lock.server.port}/v1`,
    HERMES_MODEL_API_KEY: existingKey || randomBytes(32).toString('base64url') };
  const kept = lines.filter(l => !Object.keys(values).some(k => l.startsWith(k + '=')));
  while (kept.length && kept.at(-1) === '') kept.pop();
  const temporary = path + '.' + randomBytes(6).toString('hex') + '.tmp';
  await writeFile(temporary, [...kept, ...Object.entries(values).map(([k, v]) => `${k}=${v}`), ''].join('\n'), { flag: 'wx' });
  await rename(temporary, path);
  return { state: 'configured', model: model.alias, endpoint: values.HERMES_MODEL_BASE_URL, keys: Object.keys(values) };
}

async function status() {
  const files = existsSync(home) ? await readdir(home) : [];
  const entries = [['runtime', lock.runtime.asset], ...Object.entries(lock.models).map(([k, m]) => [k, m.file])];
  return { runtimeInstalled: existsSync(server), artifacts: entries.map(([name, file]) => ({ name, file, present: files.includes(file) })),
    partialDownloads: files.filter(f => f.endsWith('.part')) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, name] = process.argv.slice(2);
  try {
    if (command === 'install' && name) console.log(JSON.stringify(await install(name)));
    else if (command === 'resolve' && name) console.log(JSON.stringify(await resolveArtifact(name)));
    else if (command === 'serve' && name) serve(name);
    else if (command === 'configure' && name) console.log(JSON.stringify(await configure(name)));
    else if (command === 'status') console.log(JSON.stringify(await status(), null, 2));
    else throw new Error('Usage: local-model.mjs install runtime|runtime-vulkan|decision|<model> | resolve runtime-vulkan|decision'
      + ' | configure <model> | serve decision|<model> | status');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
