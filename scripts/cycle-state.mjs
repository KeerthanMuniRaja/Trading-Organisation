import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Shared local-state helpers for finite intake cycles. Journals are trusted operator state, not tamper-proof.
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
export const stableHash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export async function exists(path) { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }

async function atomicWrite(path, data) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  const file = await open(temporary, 'wx');
  try { await file.writeFile(data); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
}

/** Reads at most `limit` bytes of JSON; larger files are refused rather than truncated. */
export async function readBoundedJson(path, limit) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > limit) throw new Error('Input file exceeds size limit');
    try { return JSON.parse(buffer.subarray(0, length).toString('utf8')); }
    catch { throw new Error('Input file must contain valid JSON'); }
  } finally { await handle.close(); }
}

export const save = (path, value) => atomicWrite(path, JSON.stringify(value, null, 2));
export const saveBytes = (path, bytes) => atomicWrite(path, bytes);

/** Backend origin and a hash of the single researcher credential; the raw token is never persisted. */
export function backendBinding(env) {
  const base = new URL(env.API_URL ?? 'http://127.0.0.1:3000');
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/' ||
      !(base.protocol === 'https:' || (base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))))
    throw new Error('Invalid backend origin');
  const principals = JSON.parse(env.PRINCIPALS_JSON ?? '[]');
  if (!Array.isArray(principals)) throw new Error('Invalid principals configuration');
  const researchers = principals.filter(p => p?.role === 'researcher');
  if (researchers.length !== 1 || typeof researchers[0].token !== 'string' || !researchers[0].token)
    throw new Error('Exactly one researcher credential is required');
  return { origin: base.origin, credentialHash: stableHash(researchers[0].token) };
}

/** Creates (or reuses) a real directory and takes its exclusive lock file. No stale-lock takeover. */
export async function lockDirectory(destination, lockName, label) {
  const directory = resolve(destination);
  try { await mkdir(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(label + ' directory must be a real directory');
  const lockPath = join(directory, lockName);
  let handle;
  try { handle = await open(lockPath, 'wx'); } catch (error) {
    if (error.code === 'EEXIST') throw new Error(label + ' is locked; confirm its worker has stopped before manual recovery');
    throw error;
  }
  return { directory, release: async () => { await handle.close(); await unlink(lockPath); } };
}
