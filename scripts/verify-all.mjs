// One verification gate (DEP-01): secret scan, backend build and tests, script tests, and the Python suites, with one
// pass/fail. Each suite runs in its own process; output goes to .local/verify/<suite>.log and only a summary is printed.
// Run before every push:  npm.cmd run verify        (add --quick to skip the ~10-minute backend suite)
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const win = process.platform === 'win32';
const venv = name => join(ROOT, ...name.split('/'), win ? 'Scripts' : 'bin', win ? 'python.exe' : 'python');
const REPLAY = venv('.local/replay-venv'), SKFOLIO = venv('integrations/skfolio/.venv');
const NODE = process.execPath;
const DESK_TESTS = ['test_desk', 'test_desk_v2', 'test_live', 'test_datasets', 'test_forecast', 'test_desk_learning', 'test_fitness', 'test_dashboard',
  'test_tournament', 'test_daily', 'test_portfolio_daily', 'test_ai_allocator', 'test_model_compare', 'test_risk_monitor', 'test_allocator_review',
  'test_curriculum', 'test_participants', 'test_chains', 'test_signals_bridge', 'test_regime_study', 'test_release_gate', 'test_data_steward',
  'test_signal_scorer', 'test_rule_bot', 'test_model_allocator', 'test_rnd_scout', 'test_rnd_bot', 'test_rnd_ideas', 'test_reflections', 'test_debate', 'test_market_regime', 'test_scenario_panel', 'test_research_checks', 'test_live_knowledge', 'test_playbook_drafts', 'test_knowledge_index', 'test_review_scorecard', 'test_headline_reader'];

const INTEGRATION_NODE_TESTS = ['integrations/kite/quotes.test.mjs', 'integrations/publisher-feeds/feed-client.test.mjs',
  'integrations/publisher-feeds/feed-parser.test.mjs', 'integrations/ruflo/coordinator.test.mjs', 'integrations/ruflo/dependency.test.mjs',
  'integrations/ruflo/mirror.test.mjs', 'integrations/vibe-trading/news-adapter.test.mjs', 'integrations/vibe-trading/news-client.test.mjs',
  'scripts/department-runtime.test.mjs', 'scripts/department-session.test.mjs', 'scripts/import-observations.test.mjs',
  'scripts/import-replay-evidence.test.mjs', 'scripts/import-vibe-news.test.mjs', 'scripts/model-launchers.test.mjs', 'scripts/obsidian-lessons.test.mjs',
  'scripts/obsidian-organisation.test.mjs', 'scripts/obsidian-sync.test.mjs', 'scripts/organisation-starter.test.mjs', 'scripts/review-news-queue.test.mjs',
  'scripts/run-feed-cycle.test.mjs', 'scripts/run-vibe-cycle.test.mjs'];

export function suites({ quick = false } = {}) {
  return [
    { id: 'secret-scan', cmd: NODE, args: ['scripts/secret-scan.mjs'] },
    { id: 'backend-build', cmd: NODE, args: [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'backend/tsconfig.json'] }, // same as npm run build, no shell
    ...(quick ? [] : [{ id: 'backend-tests', cmd: NODE, args: ['--test', '--test-concurrency=1', 'backend/dist/test/*.test.js'], timeoutMs: 1_800_000 }]),
    { id: 'script-tests', cmd: NODE, args: ['--test', 'scripts/backup.test.mjs', 'scripts/deliver-alerts.test.mjs', 'scripts/secret-scan.test.mjs',
      'scripts/organisation-cycle.test.mjs', 'scripts/verify-all.test.mjs', 'scripts/signal-loop.test.mjs', 'scripts/daily-digest.test.mjs', 'scripts/eod-loop.test.mjs',
      'scripts/rule-bot-loop.test.mjs', 'scripts/activate-rule-bot.test.mjs', 'scripts/readiness.test.mjs',
      'scripts/live-fitness.test.mjs', 'scripts/model-allocator-loop.test.mjs', 'scripts/agenda.test.mjs', 'scripts/bot-credential.test.mjs', 'scripts/learning-cycle.test.mjs', 'scripts/prune-env-backups.test.mjs', 'scripts/autonomy.test.mjs', 'scripts/protections.test.mjs', 'scripts/export-data.test.mjs', 'scripts/release-renewal.test.mjs', 'scripts/supervisor.test.mjs', 'scripts/debate-setup.test.mjs', 'scripts/member-setup.test.mjs', 'scripts/status.test.mjs', 'scripts/world-news.test.mjs', 'scripts/playbook.test.mjs', 'scripts/intraday-monitor.test.mjs', 'scripts/preflight.test.mjs'] },
    { id: 'trading-desk', cmd: REPLAY, args: ['-m', 'unittest', ...DESK_TESTS], cwd: join(ROOT, 'integrations', 'trading-desk'), requires: REPLAY },
    // the TradingAgents member's governance, tested with a stand-in engine (the real package is not needed)
    { id: 'tradingagents', cmd: REPLAY, args: ['-m', 'unittest', 'test_tradingagents'], cwd: join(ROOT, 'integrations', 'tradingagents'), requires: REPLAY },
    // the model evaluation suite's own logic (stand-in models; the real model is never called by the gate)
    { id: 'model-eval', cmd: REPLAY, args: ['-m', 'unittest', 'test_model_eval', 'test_build_dataset'], cwd: join(ROOT, 'integrations', 'model-eval'), requires: REPLAY },
    { id: 'quant-advisor', cmd: SKFOLIO, args: ['-m', 'unittest', 'test_quant_advisor'], cwd: join(ROOT, 'integrations', 'trading-desk'), requires: SKFOLIO },
    { id: 'claims', cmd: REPLAY, args: ['-m', 'unittest', 'test_claims', 'test_http_security', 'test_autolearn', 'test_refresh_headlines'],
      cwd: join(ROOT, 'integrations', 'claims'), requires: REPLAY },
    // everything else that has tests, so "all checks passed" means all of them (audit, 14 Oct 2026)
    { id: 'integration-tests', cmd: NODE, args: ['--test', ...INTEGRATION_NODE_TESTS] },
    { id: 'hermes', cmd: REPLAY, args: ['-m', 'unittest', 'discover', '-p', 'test_*.py'], cwd: join(ROOT, 'integrations', 'hermes'), requires: REPLAY },
    { id: 'market-replay', cmd: REPLAY, args: ['-m', 'unittest', 'discover', '-p', 'test_*.py'], cwd: join(ROOT, 'integrations', 'market-replay'), requires: REPLAY },
    { id: 'skfolio', cmd: SKFOLIO, args: ['-m', 'unittest', 'discover', '-p', 'test_*.py'], cwd: join(ROOT, 'integrations', 'skfolio'), requires: SKFOLIO },
  ];
}

/** Pulls a test count out of node:test or unittest output, when present. */
export function count(output) {
  const node = output.match(/ℹ tests (\d+)[\s\S]*?ℹ pass (\d+)/);
  if (node) return `${node[2]}/${node[1]}`;
  const py = output.match(/Ran (\d+) tests?/);
  return py ? `${py[1]} ran` : null;
}

function run(suite) {
  return new Promise(done => {
    const child = spawn(suite.cmd, suite.args, { cwd: suite.cwd ?? ROOT, shell: false, windowsHide: true, env: process.env });
    let output = '';
    child.stdout.on('data', c => { output += c; }); child.stderr.on('data', c => { output += c; });
    const timer = setTimeout(() => child.kill(), suite.timeoutMs ?? 600_000);
    child.on('close', code => { clearTimeout(timer); done({ code: code ?? 1, output }); });
    child.on('error', () => { clearTimeout(timer); done({ code: 127, output: 'could not start ' + suite.cmd }); });
  });
}

export async function verify({ quick = false, runner = run, logDir = join(ROOT, '.local', 'verify') } = {}) {
  await mkdir(logDir, { recursive: true });
  const results = [];
  for (const suite of suites({ quick })) {
    if (suite.requires && !existsSync(suite.requires)) { results.push({ id: suite.id, status: 'skipped', note: 'environment not installed' }); continue; }
    const started = Date.now();
    const r = await runner(suite);
    await writeFile(join(logDir, suite.id + '.log'), r.output);
    results.push({ id: suite.id, status: r.code === 0 ? 'passed' : 'FAILED', tests: count(r.output), seconds: Math.round((Date.now() - started) / 1000) });
    if (suite.id === 'backend-build' && r.code !== 0) break; // nothing else is meaningful without a build
  }
  return { passed: results.every(r => r.status !== 'FAILED') && !results.some(r => r.id === 'backend-build' && r.status !== 'passed'), results };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { passed, results } = await verify({ quick: process.argv.includes('--quick') });
  for (const r of results) console.log(`${r.status.padEnd(8)} ${r.id.padEnd(15)} ${r.tests ?? ''} ${r.seconds !== undefined ? `(${r.seconds}s)` : r.note ?? ''}`);
  console.log(passed ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED — see .local/verify/*.log');
  process.exitCode = passed ? 0 : 1;
}
