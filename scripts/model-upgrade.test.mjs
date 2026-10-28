import assert from 'node:assert/strict';
import test from 'node:test';
import { parseExam, routingFor } from './model-upgrade.mjs';

test('the bigger model is routed only on a SHIP verdict from our exams', () => {
  const ship = parseExam('...\nOverall: SHIP\n  debate    SHIP\nReport: C:\\x\\.local\\model-eval\\run\\report.json\n');
  assert.deepEqual(ship, { overall: 'SHIP', report: 'C:\\x\\.local\\model-eval\\run\\report.json' });
  const pin = { key: 'qwen3.5-9b-q4km', alias: 'Qwen3.5-9B-Q4_K_M' };
  const r = routingFor(pin, 8081, ship, new Date('2026-10-28T12:00:00Z'));
  assert.deepEqual([r.decision.alias, r.decision.baseUrl, r.decision.examOverall], ['Qwen3.5-9B-Q4_K_M', 'http://127.0.0.1:8081/v1', 'SHIP']);
  assert.equal(routingFor(pin, 8081, parseExam("Overall: DON'T SHIP\nReport: r.json")), null);
  assert.equal(routingFor(pin, 8081, parseExam('the server crashed')), null);       // no verdict: never routed
});
