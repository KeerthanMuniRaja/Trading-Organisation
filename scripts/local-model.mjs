import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, openSync, readFileSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';

// Pinned local model runtime. Every artifact is verified against config/local-model.lock.json before use.
const root = fileURLToPath(new URL('../', import.meta.url));
const lock = JSON.parse(readFileSync(join(root, 'config', 'local-model.lock.json'), 'utf8'));
const home = join(root, '.local', 'models');
const runtimeDir = join(home, 'llama.cpp-' + lock.runtime.release);
const server = join(runtimeDir, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');

const artifact = name => name === 'runtime'
  ? { file: lock.runtime.asset, url: lock.runtime.url, sha256: lock.runtime.sha256, bytes: lock.runtime.bytes }
  : (() => { const m = lock.models[name]; if (!m) throw new Error('Unknown model key: ' + name);
      return { file: m.file, url: `https://huggingface.co/${m.repository}/resolve/${m.commit}/${m.file}`, sha256: m.sha256, bytes: m.bytes }; })();

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
  if (name === 'runtime') {
    const result = await download('runtime');
    if (!existsSync(server)) {
      await mkdir(runtimeDir, { recursive: true });
      // Windows 10+ ships bsdtar, which extracts zip archives without a third-party tool.
      const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
      const extracted = spawnSync(tar, ['-xf', join(home, lock.runtime.asset), '-C', runtimeDir], { windowsHide: true });
      if (extracted.status !== 0 || !existsSync(server)) throw new Error('Runtime archive could not be extracted');
    }
    return { ...result, server: 'installed' };
  }
  return download(name);
}

function serve(name) {
  const model = lock.models[name];
  if (!model) throw new Error('Unknown model key: ' + name);
  const weights = join(home, model.file);
  if (!existsSync(server) || !existsSync(weights)) throw new Error('Install the runtime and model first');
  const key = process.env.HERMES_MODEL_API_KEY;
  if (!key) throw new Error('HERMES_MODEL_API_KEY is required; run configure first');
  const s = lock.server;
  const args = ['-m', weights, '--alias', model.alias, '--host', s.host, '--port', String(s.port), '-c', String(s.contextTokens), '--parallel', String(s.parallel),
    '--jinja', '--reasoning', s.reasoning, '--reasoning-format', 'deepseek', '--no-webui'];
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

const [command, name] = process.argv.slice(2);
try {
  if (command === 'install' && name) console.log(JSON.stringify(await install(name)));
  else if (command === 'serve' && name) serve(name);
  else if (command === 'configure' && name) console.log(JSON.stringify(await configure(name)));
  else if (command === 'status') console.log(JSON.stringify(await status(), null, 2));
  else throw new Error('Usage: local-model.mjs install runtime|<model> | configure <model> | serve <model> | status');
} catch (error) { console.error(error.message); process.exitCode = 1; }
