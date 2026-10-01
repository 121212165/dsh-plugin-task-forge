import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLine, parseLedger, eventLine, foldStates, renderForgeList, renderSection, type LedgerEvent } from '../src/ledger.ts';

let seq = 0;
const ev = (over: Partial<LedgerEvent>): LedgerEvent => {
  seq += 1;
  return { ts: `2026-10-01T0${seq}:00:00.000Z`, task: '20261001-a3f2', event: 'created', ...over } as LedgerEvent;
};

const history: LedgerEvent[] = [
  ev({ event: 'created', version: 1, status: 'draft', title: '定制家具自动报价引擎' }),
  ev({ event: 'relayed', version: 1, status: 'relayed', target: '窗口A' }),
  ev({ event: 'acked', version: 1, status: 'relayed', target: '窗口A', note: 'need-input · 缺口 2 条' }),
  ev({ event: 'gap-resolved', version: 2, status: 'relayed', note: 'Q3 → D2' }),
  ev({ event: 'relayed', version: 2, status: 'relayed', target: 'plugtest' }),
  ev({ event: 'acked', version: 2, status: 'ready', target: 'plugtest' }),
];

test('parseLedger drops damaged lines and counts them, never throws', () => {
  const content = [JSON.stringify(history[0]), '{ broken', JSON.stringify({ task: 'x', event: 'nope', ts: '2026-01-01' }), ''].join('\n');
  const parsed = parseLedger(content);
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.skipped, 2);
  assert.deepEqual(parseLedger('').events, []);
});

test('eventLine keeps JSONL shape even when the note carries newlines', () => {
  const line = eventLine(ev({ event: 'relayed', note: '多行\n备注\t带制表' }));
  assert.equal(line.split('\n').length, 1);
  assert.ok(!line.includes('\t'));
  const back = parseLine(line);
  assert.equal(back?.note, '多行 备注 带制表');
});

test('foldStates: later events win; relay/ack targets accumulate; title sticks', () => {
  const states = foldStates(history);
  assert.equal(states.length, 1);
  const state = states[0]!;
  assert.equal(state.version, 2);
  assert.equal(state.status, 'ready');
  assert.equal(state.title, '定制家具自动报价引擎');
  assert.deepEqual(state.targets, ['窗口A', 'plugtest']);
  assert.equal(state.events, 6);
  assert.equal(state.lastAt, history[5]!.ts);
});

test('foldStates keeps unrelated tasks separate and sorts by most recent activity', () => {
  const states = foldStates([
    ev({ task: '20261001-a3f2', event: 'created', version: 1, status: 'draft', title: '老任务' }),
    ev({ task: '20261002-b7k1', event: 'created', version: 1, status: 'draft', title: '新任务' }),
  ]);
  assert.deepEqual(
    states.map((state) => state.id),
    ['20261002-b7k1', '20261001-a3f2'],
  );
});

test('renderForgeList shows id@version, status and targets; empty ledger teaches the command', () => {
  assert.ok(renderForgeList([]).includes('/forge'));
  const text = renderForgeList(foldStates(history));
  assert.ok(text.includes('20261001-a3f2@v2 [ready]'));
  assert.ok(text.includes('已交接: 窗口A, plugtest'));
  const skipped = renderForgeList(foldStates(history), 3);
  assert.ok(skipped.includes('3 行台账损坏'));
});

test('renderSection: done tasks drop out, live tasks show with marks and budget caps', () => {
  const budget = { limit: 8, maxChars: 900 };
  assert.equal(renderSection([], budget), '');
  assert.equal(renderSection([{ ...foldStates(history)[0]!, status: 'done' }], budget), '');

  const text = renderSection(foldStates(history), budget);
  assert.ok(text.startsWith('## 进行中任务（task-forge）'));
  assert.ok(text.includes('id@version') || text.includes('20261001-a3f2@v2'));
  assert.ok(text.includes('握手'));

  // newest first — renderSection consumes foldStates output, it does not sort
  const many = ['c', 'b', 'a'].map((letter, index) => ({
    id: `2026100${2 - index}-a${letter}${2 - index}x`,
    title: `${letter} 的任务，标题还比较长一些`,
    version: index + 1,
    status: 'relayed',
    targets: [`窗口-${letter}`],
    lastAt: `2026-10-0${3 - index}T00:00:00.000Z`,
    events: 1,
  }));
  const capped = renderSection(many as never, { limit: 2, maxChars: 900 });
  assert.equal(capped.split('\n').length, 4); // header + intro + 2 lines
  assert.ok(capped.includes('20261002-ac2x'));
  assert.ok(!capped.includes('20261000-a0x'));

  // char budget: a lone oversized line is truncated, never dropped
  const huge = [{ ...many[0]!, title: '长'.repeat(2000) }];
  const truncated = renderSection(huge as never, { limit: 8, maxChars: 100 });
  assert.equal(truncated.split('\n').length, 3);
  assert.ok(truncated.split('\n')[2]!.length <= 100);
  assert.ok(truncated.endsWith('…'));
});
