import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
const execute = promisify(execFile);
const identifier = /^[a-zA-Z0-9_-]{1,80}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const key = body => 'replay-' + createHash('sha256').update(JSON.stringify(body)).digest('hex');

export async function prepare(run, sourceId) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const python = join(root, '.local/replay-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
  Object.assign(env, { PYTHONNOUSERSITE: '1', PYTHONIOENCODING: 'utf-8' });
  try {
    const { stdout } = await execute(python, [join(root, 'integrations/market-replay/export_evidence.py'), run, sourceId],
      { cwd: root, env, timeout: 30_000, maxBuffer: 65536, windowsHide: true, shell: false });
    return JSON.parse(stdout);
  } catch { throw new Error('Replay preparation failed. Recompute and inspect the saved artifacts; nothing was submitted.'); }
}

export async function importReplay({ mode, run, sourceId, botId }, env = process.env, transport = fetch, preparer = prepare) {
  if (!['evidence', 'lesson'].includes(mode) || !run || !identifier.test(sourceId) ||
      (mode === 'lesson' ? !identifier.test(botId ?? '') : botId !== undefined)) throw new Error('Invalid replay import arguments');
  const base = new URL(env.API_URL ?? 'http://127.0.0.1:3000');
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/' ||
      !(base.protocol === 'https:' || (base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))) throw new Error('Invalid backend API origin');
  const researchers = JSON.parse(env.PRINCIPALS_JSON ?? '[]').filter(p => p.role === 'researcher');
  if (researchers.length !== 1 || typeof researchers[0].token !== 'string' || !researchers[0].token) throw new Error('Configure exactly one researcher credential');
  const bundle = await preparer(run, sourceId);
  const e = bundle?.evidence;
  if (!e || Object.keys(e).sort().join(',') !== 'content,kind,publishedAt,sourceId' || e.sourceId !== sourceId || e.kind !== 'dataset' ||
      typeof e.content !== 'string' || !e.content || e.content.length > 4000 || !Number.isFinite(Date.parse(e.publishedAt)) ||
      typeof bundle.lessonContent !== 'string' || !bundle.lessonContent || bundle.lessonContent.length > 4000) throw new Error('Invalid prepared replay evidence');
  async function submit(route, body) {
    try {
      const response = await transport(new URL(route, base), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { Authorization: 'Bearer ' + researchers[0].token, 'Content-Type': 'application/json', 'Idempotency-Key': key(body) }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error('not acknowledged');
      const result = await response.json();
      if (!uuid.test(result.id ?? '')) throw new Error('invalid acknowledgement');
      return result;
    } catch { throw new Error(`Replay ${route === '/v1/evidence' ? 'evidence' : 'lesson'} was not acknowledged. Review backend status and rerun the same command to recover. Independent evidence approval is required before proposing a lesson.`); }
  }
  const evidence = await submit('/v1/evidence', e);
  if (mode === 'evidence') return { evidenceId: evidence.id, reviewRequired: true, scope: 'unverified-replay-evidence' };
  // Backend rechecks current verified support; the historical evidence receipt is not an approval.
  const lesson = await submit('/v1/lessons', { botId, evidenceId: evidence.id, content: bundle.lessonContent });
  return { evidenceId: evidence.id, lessonId: lesson.id, reviewRequired: true, scope: 'unverified-lesson', qualificationChanged: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [mode, run, sourceId, botId, ...extra] = process.argv.slice(2);
    if (extra.length) throw new Error('Too many arguments');
    console.log(JSON.stringify(await importReplay({ mode, run, sourceId, botId })));
  } catch (error) {
    console.error(error instanceof SyntaxError ? 'Invalid local configuration' : error.message);
    process.exitCode = 1;
  }
}
