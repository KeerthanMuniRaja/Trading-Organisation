import { inspectRuntime } from './runtime.mjs';

const report = await inspectRuntime();
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ready ? 0 : 1;
