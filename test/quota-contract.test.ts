/** Pure tests for reading quota's published budget contract.
 * @module test/quota-contract */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BUDGET_WARN_RATIO, SUMMARY_MAX_AGE_MS, budgetWarningLine, parseQuotaSummary, type QuotaSummary } from '../src/quota-contract.ts';

const NOW = new Date('2026-10-02T09:00:00.000Z');
const fresh = NOW.toISOString();

function summary(over: Partial<QuotaSummary> = {}): QuotaSummary {
  return {
    updatedAt: fresh,
    currency: 'CNY',
    budgetTokens: 100_000,
    maxSessionTokens: 85_000,
    maxSessionRatio: 0.85,
    nextTurnEstTokens: 30_000,
    todayTokens: 90_000,
    todayCostMicros: 12_345,
    sessions: 2,
    ...over,
  };
}

test('the summary is parsed tolerantly: anything unusable is null, never a half-object', () => {
  const parsed = parseQuotaSummary(JSON.stringify(summary()));
  assert.deepEqual(parsed, summary());

  for (const junk of [null, undefined, '', '   ', '{ nope', '[]', '"a string"', '42']) {
    assert.equal(parseQuotaSummary(junk), null, String(junk));
  }
  // every field the warning arithmetic depends on must be present and sane
  assert.equal(parseQuotaSummary(JSON.stringify({ ...summary(), updatedAt: 'yesterday' })), null);
  assert.equal(parseQuotaSummary(JSON.stringify({ ...summary(), budgetTokens: -1 })), null);
  assert.equal(parseQuotaSummary(JSON.stringify({ ...summary(), maxSessionTokens: 'x' })), null);
  assert.equal(parseQuotaSummary(JSON.stringify({ updatedAt: fresh, budgetTokens: 1 })), null, 'a partial file is not a contract');
  // a ratio/estimate that is neither null nor a usable number means the writer changed shape
  assert.equal(parseQuotaSummary(JSON.stringify({ ...summary(), maxSessionRatio: 'hot' })), null);
  assert.equal(parseQuotaSummary(JSON.stringify({ ...summary(), nextTurnEstTokens: 'lots' })), null);

  // explicit nulls are meaningful and survive
  const cold = parseQuotaSummary(JSON.stringify({ ...summary(), maxSessionRatio: null, nextTurnEstTokens: null }));
  assert.equal(cold!.maxSessionRatio, null);
  assert.equal(cold!.nextTurnEstTokens, null);
  // a missing currency degrades to no money text, not to a wrong symbol
  assert.equal(parseQuotaSummary(JSON.stringify({ ...summary(), currency: undefined }))!.currency, '');
});

test('no warning is emitted for anything the numbers cannot support', () => {
  assert.equal(budgetWarningLine(null, NOW), '');
  assert.equal(budgetWarningLine(summary({ updatedAt: new Date(NOW.getTime() - SUMMARY_MAX_AGE_MS - 1).toISOString() }), NOW), '', 'stale readings stay quiet');
  assert.equal(budgetWarningLine(summary({ budgetTokens: 0, maxSessionRatio: null }), NOW), '', 'no budget configured');
  assert.equal(budgetWarningLine(summary({ maxSessionRatio: null }), NOW), '', 'a ratio the writer refused to compute cannot be invented here');
  assert.equal(budgetWarningLine(summary({ maxSessionTokens: 79_000, maxSessionRatio: 0.79 }), NOW), '', `only at or above ${BUDGET_WARN_RATIO * 100}%`);
  assert.equal(budgetWarningLine(summary({ currency: '' }), NOW), '⚠ 预算已用 85%（85k/100k），下步预估再吃 ~30k——这条交接大概率会烧穿预算。先 /qm 看清余量、或收尾后 /qm-reset，再决定要不要现在开工。');
});

test('a hot budget is warned about with the actual arithmetic shown', () => {
  const blown = budgetWarningLine(summary(), NOW);
  assert.ok(blown.startsWith('⚠ '), blown);
  assert.ok(blown.includes('85%（85k/100k）'), blown);
  assert.ok(blown.includes('下步预估再吃 ~30k'), blown);
  assert.ok(blown.includes('大概率会烧穿'), blown);
  assert.ok(blown.includes('/qm'), blown);
  assert.ok(blown.includes('约 0.01 CNY'), blown);
  assert.equal(blown.split('\n').length, 1);

  // still over the line but with room for the next step: a softer mark
  const warm = budgetWarningLine(summary({ maxSessionTokens: 85_000, nextTurnEstTokens: 10_000 }), NOW);
  assert.ok(warm.startsWith('△ '), warm);
  assert.ok(!warm.includes('烧穿'), warm);

  // with no forecast the ratio alone still speaks, and does not claim a number
  const noForecast = budgetWarningLine(summary({ nextTurnEstTokens: null }), NOW);
  assert.ok(noForecast.startsWith('⚠ '), noForecast);
  assert.ok(!noForecast.includes('下步预估'), noForecast);
});
