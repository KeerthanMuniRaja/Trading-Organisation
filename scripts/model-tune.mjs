// Model tuning (MODEL-SPEED-01): measures, on THIS machine, which thread counts and which runtime (CPU, or Vulkan on the
// integrated graphics) run our model fastest, with llama.cpp's own llama-bench, and writes .local/models/tuning.json for
// local-model.mjs serve. Chosen for our real workload: a call reads about 600 prompt tokens and writes about 150, so
// the setting that minimises the time of such a call wins. Run with the model server stopped (they share the CPU).
//   node scripts/model-tune.mjs            (measure and write)      node scripts/model-tune.mjs --show
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TUNING, runtimeExe, vulkanDir } from './local-model.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const lock = JSON.parse(readFileSync(join(root, 'config', 'local-model.lock.json'), 'utf8'));
const home = join(root, '.local', 'models');
export const WORKLOAD = { prompt: 600, generated: 150 };

/** Thread counts worth trying on a machine with this many logical processors. */
export function candidates(logical) {
  return [...new Set([2, 4, 6, 8, Math.floor(logical / 2), logical - 2, logical].filter(t => t >= 1 && t <= logical))].sort((a, b) => a - b);
}

/** From llama-bench JSON rows (prompt rows have n_prompt > 0, generation rows n_gen > 0): the best generation threads,
 *  the best prompt threads, and the seconds a typical call would take. */
export function best(rows) {
  const pp = rows.filter(r => r.n_prompt > 0 && r.n_gen === 0), tg = rows.filter(r => r.n_gen > 0 && r.n_prompt === 0);
  if (!pp.length || !tg.length) return null;
  const top = xs => xs.reduce((a, b) => (b.avg_ts > a.avg_ts ? b : a));
  const p = top(pp), g = top(tg);
  return { threads: g.n_threads, threadsBatch: p.n_threads, promptTokensPerSecond: Math.round(p.avg_ts * 10) / 10,
    generatedTokensPerSecond: Math.round(g.avg_ts * 10) / 10,
    secondsPerCall: Math.round((WORKLOAD.prompt / p.avg_ts + WORKLOAD.generated / g.avg_ts) * 10) / 10 };
}

/** The faster runtime for a typical call; the CPU build wins ties (fewer moving parts). */
export function choose(cpu, vulkan) {
  if (!cpu && !vulkan) return null;
  if (vulkan && (!cpu || vulkan.secondsPerCall < cpu.secondsPerCall * 0.9)) return { runtime: 'vulkan', gpuLayers: 99, ...vulkan };
  return { runtime: 'cpu', ...cpu };
}

function bench(exe, weights, threads, extra = []) {
  const run = spawnSync(exe, ['-m', weights, '-t', threads.join(','), '-p', '512', '-n', '64', '-r', '2', '-o', 'json', ...extra],
    { encoding: 'utf8', windowsHide: true, timeout: 45 * 60_000, maxBuffer: 16 * 1024 * 1024 });
  if (run.status !== 0) return { error: (run.stderr || run.error?.message || 'llama-bench failed').slice(-300) };
  try { return { rows: JSON.parse(run.stdout) }; } catch { return { error: 'llama-bench gave no JSON' }; }
}

async function main() {
  if (process.argv.includes('--show')) { console.log(existsSync(TUNING) ? readFileSync(TUNING, 'utf8') : 'not tuned yet'); return; }
  const port = lock.server.port;
  const busy = await fetch(`http://${lock.server.host}:${port}/health`, { signal: AbortSignal.timeout(2000) }).then(r => r.ok, () => false);
  if (busy && !process.argv.includes('--force')) throw new Error(`A model server is running on port ${port}; stop it first (they would share the CPU and skew the result)`);
  const model = lock.models['qwen3.5-4b-q4km'], weights = join(home, model.file);
  const cpuExe = runtimeExe(join(home, 'llama.cpp-' + lock.runtime.release), 'llama-bench'), vkExe = runtimeExe(vulkanDir, 'llama-bench');
  if (!existsSync(cpuExe) || !existsSync(weights)) throw new Error('Install the runtime and the 4B model first');
  const threads = candidates(availableParallelism());
  console.error(`Measuring threads ${threads.join(', ')} on the CPU build (several minutes)...`);
  const cpuRun = bench(cpuExe, weights, threads);
  const vkRun = existsSync(vkExe) ? (console.error('Measuring the Vulkan build on the integrated graphics...'), bench(vkExe, weights, threads, ['-ngl', '99'])) : null;
  const cpu = cpuRun.rows ? best(cpuRun.rows) : null, vulkan = vkRun?.rows ? best(vkRun.rows) : null;
  const chosen = choose(cpu, vulkan);
  if (!chosen) throw new Error('Nothing could be measured: ' + (cpuRun.error ?? '') + ' ' + (vkRun?.error ?? ''));
  const report = { ...chosen, measuredAt: new Date().toISOString(), model: model.alias, logicalProcessors: availableParallelism(), workload: WORKLOAD,
    measured: { cpu, vulkan, ...(vkRun?.error ? { vulkanError: vkRun.error } : {}) } };
  await mkdir(home, { recursive: true });
  await writeFile(TUNING, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ runtime: report.runtime, threads: report.threads, threadsBatch: report.threadsBatch, secondsPerCall: report.secondsPerCall,
    cpuSecondsPerCall: cpu?.secondsPerCall ?? null, vulkanSecondsPerCall: vulkan?.secondsPerCall ?? null }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
