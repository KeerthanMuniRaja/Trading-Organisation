import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RufloCoordinator, RUFLO_VERSION } from './coordinator.mjs';

const root = dirname(fileURLToPath(import.meta.url));
await mkdir(join(root, '.state'), { recursive: true });
const stateDir = await mkdtemp(join(root, '.state', 'smoke-'));
let coordinator;
let report;
try {
  coordinator = await RufloCoordinator.open({ stateDir });
  const experimentId = 'local-contract-smoke';
  const task = await coordinator.createResearchTask(experimentId, 'Local software contract test only; no market execution or model inference.');
  assert.equal((await coordinator.getResearchTask(experimentId)).status, 'pending');
  const completion = { resultReference: 'local:smoke/contract-check', outcome: 'completed' };
  await coordinator.completeResearchTask(experimentId, completion);
  assert.equal((await coordinator.getResearchTask(experimentId)).status, 'completed');
  assert.equal((await coordinator.completeResearchTask(experimentId, completion)).reused, true);
  const store = JSON.parse(await readFile(join(stateDir, 'workspace', '.claude-flow', 'tasks', 'store.json'), 'utf8'));
  assert.equal(store.tasks[task.taskId].result.authority, 'application-owned');
  report = { status: 'passed', packageVersion: RUFLO_VERSION, serverInfo: coordinator.contract.serverInfo,
    methods: ['initialize', 'tools/list', 'tools/call'], tools: coordinator.contract.tools.map(t => t.name),
    taskId: task.taskId, taskState: 'completed', stateDir,
    note: 'Actual installed Ruflo local MCP; task records only. No model inference, financial authority, or live trading.' };
  await writeFile(join(stateDir, 'contract.json'), JSON.stringify(coordinator.contract, null, 2));
  await writeFile(join(root, '.state', 'last-smoke.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch(error) {
  report = {status:'failed',packageVersion:RUFLO_VERSION,serverInfo:coordinator?.contract.serverInfo??null,
    tools:coordinator?.contract.tools.map(t=>t.name)??[],stateDir,
    error:error.message,code:error.code??'MCP_UNAVAILABLE',upstreamCause:error.cause?.message??null,
    note:'Task lifecycle did not complete. No financial operation was attempted.'};
  await writeFile(join(root,'.state','last-smoke.json'),JSON.stringify(report,null,2));
  console.error(JSON.stringify(report,null,2));
  process.exitCode=1;
} finally { await coordinator?.close(); }
