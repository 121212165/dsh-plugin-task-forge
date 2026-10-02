/** Pure tests for the task-book token-cost estimator.
 * @module test/task-cost */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CHARS_PER_TOKEN,
  estimateTaskCost,
  parseHistory,
  renderCostCompact,
  renderCostLine,
  type StepUsage,
} from '../src/task-cost.ts';

const book = (n: number): string => '中'.repeat(n);

test('tokens come from the char count divided by the documented approximation', () => {
  assert.equal(CHARS_PER_TOKEN, 2.4);
  const cost = estimateTaskCost({ text: book(2400), windows: 1 });
  assert.equal(cost.compile, 1000, '2400 chars / 2.4 = 1000 tokens');
  assert.equal(cost.readback, 400, 'heuristic read-back is 40% of the book');
  assert.equal(estimateTaskCost({ text: book(24), windows: 1 }).compile, 10);
});

test('with no observations every phase is char-derived and the sum holds', () => {
  const cost = estimateTaskCost({ text: book(2400), windows: 1 });
  assert.equal(cost.observed, false);
  assert.equal(cost.stepCount, 0);
  assert.equal(cost.executeLow, 8000);
  assert.equal(cost.executeHigh, 18000);
  assert.equal(cost.low, cost.compile + cost.readback + cost.relay + cost.executeLow);
  assert.equal(cost.high, cost.compile + cost.readback + cost.relay + cost.executeHigh);
  assert.equal(cost.low, 10400);
  assert.equal(cost.high, 20400);
});

test('execution is the only range and the totals bracket it', () => {
  const cost = estimateTaskCost({ text: book(5000), windows: 2 });
  assert.ok(cost.executeHigh > cost.executeLow);
  assert.ok(cost.high > cost.low);
  assert.equal(cost.high - cost.low, cost.executeHigh - cost.executeLow, 'only execution widens the range');
});

test('observed steps replace the heuristic: median output and median step drive the phases', () => {
  const steps: StepUsage[] = [
    { input: 1000, output: 2000, cacheRead: 0 },
    { input: 100, output: 4000, cacheRead: 100 },
    { input: 50, output: 6000, cacheRead: 0 },
  ];
  const cost = estimateTaskCost({ text: book(2400), windows: 1, steps });
  assert.equal(cost.observed, true);
  assert.equal(cost.stepCount, 3);
  assert.equal(cost.compile, 1000, 'compiling still writes the whole book regardless of history');
  assert.equal(cost.readback, 4000, 'median observed step output');
  assert.equal(cost.executeLow, 25200, 'median step total 4200 × 6');
  assert.equal(cost.executeHigh, 84000, 'median step total 4200 × 20');
  assert.equal(cost.low, cost.compile + cost.readback + cost.relay + cost.executeLow);
});

test('median of an even number of steps averages the two middle values', () => {
  const steps: StepUsage[] = [
    { input: 0, output: 2, cacheRead: 0 },
    { input: 0, output: 8, cacheRead: 0 },
    { input: 0, output: 4, cacheRead: 0 },
    { input: 0, output: 6, cacheRead: 0 },
  ];
  assert.equal(estimateTaskCost({ text: book(1), windows: 1, steps }).readback, 5);
});

test('the relay send is multiplied by however many windows hold the book', () => {
  const one = estimateTaskCost({ text: book(2400), windows: 1 });
  const three = estimateTaskCost({ text: book(2400), windows: 3 });
  assert.equal(one.relayPerWindow, 1000);
  assert.equal(one.relay, 1000);
  assert.equal(three.relay, 3000, 'each window re-pays the whole-book send');
  assert.ok(three.low > one.low);
  assert.equal(three.low - one.low, 2000, 'only the relay term grows with windows');
  assert.match(renderCostLine(three), /交接 1k×3窗/);
});

test('the rendered line distinguishes 观测 from 估算 and always keeps the range', () => {
  const heuristic = renderCostLine(estimateTaskCost({ text: book(2400), windows: 1 }));
  assert.ok(heuristic.includes('预计烧 10k–20k tok'), heuristic);
  assert.ok(heuristic.includes('编译 1k + 回读 400 + 交接 1k×1窗 + 执行 8k–18k'), heuristic);
  assert.ok(heuristic.includes('启发式'), heuristic);
  assert.ok(heuristic.includes('无观测'), heuristic);

  const observed = renderCostLine(estimateTaskCost({ text: book(2400), windows: 1, steps: [{ input: 1000, output: 2000, cacheRead: 0 }] }));
  assert.ok(observed.includes('基于 1 步观测'), observed);
  assert.ok(!observed.includes('启发式'), observed);
});

test('money renders only when a real price is passed, tokens-only otherwise', () => {
  const cost = estimateTaskCost({ text: book(2400), windows: 1 });
  assert.ok(!renderCostLine(cost).includes('≈'), 'no price, no money');
  assert.ok(!renderCostLine(cost, null).includes('≈'));
  const priced = renderCostLine(cost, { currency: 'CNY', microsPerToken: 2 });
  assert.match(priced, /≈[\d.]+ CNY/, priced);
  // a currency-less or zero price cannot produce money, and must not invent a symbol
  assert.ok(!renderCostLine(cost, { currency: '', microsPerToken: 2 }).includes('≈'));
  assert.ok(!renderCostLine(cost, { currency: 'CNY', microsPerToken: 0 }).includes('≈'));
});

test('the compact form is a short token range for the ledger line', () => {
  assert.equal(renderCostCompact(estimateTaskCost({ text: book(2400), windows: 1 })), '预估 10k–20k');
});

test('the estimator is deterministic: same inputs, same numbers', () => {
  const a = estimateTaskCost({ text: book(1234), windows: 2, steps: [{ input: 3, output: 7, cacheRead: 1 }] });
  const b = estimateTaskCost({ text: book(1234), windows: 2, steps: [{ input: 3, output: 7, cacheRead: 1 }] });
  assert.deepEqual(a, b);
});

test('history.json is read tolerantly: anything wrong collapses to no observations', () => {
  assert.deepEqual(parseHistory(null), []);
  assert.deepEqual(parseHistory(undefined), []);
  assert.deepEqual(parseHistory(''), []);
  assert.deepEqual(parseHistory('   '), []);
  assert.deepEqual(parseHistory('{ half-written'), []);
  assert.deepEqual(parseHistory('[]'), [], 'an array is not a session map');
  assert.deepEqual(parseHistory('"a string"'), []);
  assert.deepEqual(parseHistory('42'), []);
  assert.deepEqual(parseHistory(JSON.stringify({ s1: 'not an array' })), []);
  assert.deepEqual(parseHistory(JSON.stringify({ s1: null })), []);
  // negative numbers, missing fields, and non-numeric fields are all rejected
  assert.deepEqual(parseHistory(JSON.stringify({ s1: [{ input: -1, output: 2, cacheRead: 0 }] })), []);
  assert.deepEqual(parseHistory(JSON.stringify({ s1: [{ input: 1, output: 'lots', cacheRead: 0 }] })), []);
  assert.deepEqual(parseHistory(JSON.stringify({ s1: [{ input: 1, output: 2 }] })), [], 'cacheRead is required');
});

test('a well-formed history flattens across sessions and keeps only valid steps', () => {
  const steps = parseHistory(JSON.stringify({
    a: [{ input: 10, output: 20, cacheRead: 30 }, 'junk', { input: -5, output: 1, cacheRead: 1 }],
    b: [{ input: 1, output: 2, cacheRead: 3 }],
  }));
  assert.deepEqual(steps, [
    { input: 10, output: 20, cacheRead: 30 },
    { input: 1, output: 2, cacheRead: 3 },
  ]);
  // garbage history flips the estimate back onto the heuristic path
  assert.equal(estimateTaskCost({ text: book(2400), windows: 1, steps: parseHistory('{ broken') }).observed, false);
});
