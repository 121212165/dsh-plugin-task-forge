import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  makeTaskId,
  isValidTaskId,
  deriveTitle,
  validateTask,
  revise,
  findOpenLine,
  applyAnswer,
  renderTaskMarkdown,
  parseTaskMarkdown,
  renderCompileInstruction,
  outboxName,
  HANDSHAKE_TEXT,
  type TaskBook,
} from '../src/taskbook.ts';

const base: TaskBook = {
  v: 1,
  id: '20261001-a3f2',
  version: 1,
  status: 'draft',
  title: '定制家具自动报价引擎',
  mode: 'auto',
  createdAt: '2026-10-01T08:00:00.000Z',
  updatedAt: '2026-10-01T08:00:00.000Z',
  targets: [],
  goal: '做一个报价引擎',
  context: '已有 1200 行 SKU 表',
  constraints: '不引入新依赖',
  acceptance: 'A1: 1200 行回归零偏差\nA2: 非标宽触发人工确认',
  decisions: 'D1: 半自动+编号对齐（跨源卡点只能靠编号消灭）',
  open: 'Q1: 香槟金是否在价目表内\nQ2: 见光板计价口径',
};

test('makeTaskId uses the local date plus a 4-char safe alphabet suffix', () => {
  const id = makeTaskId(new Date(2026, 9, 1), () => 0.12345);
  assert.equal(id, '20261001-' + id.slice(9));
  assert.ok(isValidTaskId(id));
  assert.ok(!/[ilo01]/.test(id.slice(9)));
  assert.equal(isValidTaskId('2026101-x'), false);
  assert.equal(isValidTaskId('20261001-toolong99'), false);
  // suffixes differ across draws
  assert.notEqual(makeTaskId(new Date(), () => 0.1), makeTaskId(new Date(), () => 0.9));
});

test('deriveTitle takes the first line, collapses spaces, and caps length', () => {
  assert.equal(deriveTitle('  做一个   报价\n引擎  '), '做一个 报价');
  assert.equal(deriveTitle('x'.repeat(50)).length, 40);
  assert.ok(deriveTitle('x'.repeat(50)).endsWith('…'));
  assert.equal(deriveTitle('\n\n第二行'), '第二行');
});

test('validateTask reports every broken field, and a clean book passes', () => {
  assert.deepEqual(validateTask(base), []);
  const broken = validateTask({ ...base, id: 'nope', version: 0, status: 'nope' as never, mode: 'x' as never, title: '', createdAt: 'x', updatedAt: '', targets: [''], goal: ' ', acceptance: '' });
  assert.equal(broken.length, 10);
});

test('revise bumps version and updatedAt but nothing else', () => {
  const next = revise(base, new Date('2026-10-02T00:00:00Z'));
  assert.equal(next.version, 2);
  assert.equal(next.updatedAt, '2026-10-02T00:00:00.000Z');
  assert.equal(next.goal, base.goal);
  assert.equal(revise(next).version, 3);
});

test('findOpenLine matches Q numbers with or without separators, ignores body text', () => {
  assert.equal(findOpenLine(base, 'Q1'), 'Q1: 香槟金是否在价目表内');
  assert.equal(findOpenLine(base, '2'), 'Q2: 见光板计价口径');
  assert.equal(findOpenLine(base, 'Q3'), null);
  assert.equal(findOpenLine(base, ''), null);
});

test('applyAnswer moves the gap into DECISIONS, renumbers, and bumps version', () => {
  const result = applyAnswer(base, 'Q1', '香槟金在表内，走修正系数', new Date('2026-10-02T09:00:00Z'));
  assert.equal(result.kind, 'answered');
  if (result.kind !== 'answered') return;
  assert.equal(result.qid, 'Q1');
  assert.equal(result.decisionId, 'D2');
  assert.equal(result.task.version, 2);
  assert.ok(result.task.decisions.includes('D2（原 Q1 已答）: 香槟金在表内，走修正系数'));
  assert.ok(!result.task.open.includes('香槟金'));
  assert.ok(result.task.open.includes('Q2'));

  // answering a missing gap is a typed miss, not a throw
  assert.equal(applyAnswer(base, 'Q9', 'x').kind, 'missing');
  // decision numbering counts existing D lines even without the second one
  const onlyD0 = applyAnswer({ ...base, decisions: '' }, 'Q2', '口径见 A2');
  if (onlyD0.kind === 'answered') assert.ok(onlyD0.task.decisions.includes('D1（原 Q2 已答）'));
});

test('renderTaskMarkdown carries frontmatter, all sections, and the fixed handshake', () => {
  const md = renderTaskMarkdown({ ...base, targets: ['web-A', 'plugtest'] });
  assert.ok(md.startsWith('---\nid: 20261001-a3f2\nversion: 1'));
  assert.ok(md.includes('targets: [web-A, plugtest]'));
  for (const heading of ['## 目标（GOAL）', '## 背景（CONTEXT）', '## 约束（CONSTRAINTS）', '## 验收标准（ACCEPTANCE）', '## 已定决策（DECISIONS）', '## 开放缺口（OPEN）', '## 握手指令（HANDSHAKE）']) {
    assert.ok(md.includes(heading), heading);
  }
  assert.ok(md.includes('不要创建文件'));
  assert.ok(md.endsWith('\n'));
  assert.equal(md.includes(HANDSHAKE_TEXT), true);
});

test('parseTaskMarkdown roundtrips renderTaskMarkdown, and reports garbage instead of throwing', () => {
  const relayed = { ...base, version: 3, status: 'relayed' as const, targets: ['窗口A'] };
  const parsed = parseTaskMarkdown(renderTaskMarkdown(relayed));
  assert.deepEqual(parsed.issues, []);
  assert.deepEqual(parsed.task, relayed);

  const noMeta = parseTaskMarkdown('随便一段话，没有 frontmatter');
  assert.equal(noMeta.task, null);
  assert.ok(noMeta.issues[0]!.includes('frontmatter'));

  const broken = parseTaskMarkdown('---\nid: 20261001-a3f2\nversion: abc\n---\n\n# 任务书\n\n## 目标（GOAL）\n做点事');
  assert.ok(broken.task); // 结构能救回来，但坏字段全部点名
  assert.ok(broken.issues.some((issue) => issue.includes('version')));
  assert.ok(broken.issues.some((issue) => issue.includes('status')));
});

test('outboxName stamps the version so receivers can tell copies apart', () => {
  assert.equal(outboxName(base), '20261001-a3f2-v1.md');
  assert.equal(outboxName(revise(base)), '20261001-a3f2-v2.md');
});

test('renderCompileInstruction switches guidance by mode and embeds the raw need', () => {
  const auto = renderCompileInstruction(base, '帮我做个报价');
  assert.ok(auto.includes('20261001-a3f2'));
  assert.ok(auto.includes('"""') && auto.includes('帮我做个报价'));
  assert.ok(auto.includes('auto 模式'));
  assert.ok(auto.includes('forge_write'));
  assert.ok(!auto.includes('interview 模式'));

  const interview = renderCompileInstruction({ ...base, mode: 'interview' }, '帮我做个报价');
  assert.ok(interview.includes('interview 模式'));
  assert.ok(interview.includes('questions'));
});
