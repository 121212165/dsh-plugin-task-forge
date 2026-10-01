import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHandshake, isStaleVersion, needsSenderInput, renderAckReply } from '../src/handshake.ts';
import { type TaskBook } from '../src/taskbook.ts';

const task: TaskBook = {
  v: 1,
  id: '20261001-a3f2',
  version: 2,
  status: 'relayed',
  title: '定制家具自动报价引擎',
  mode: 'auto',
  createdAt: '2026-10-01T08:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
  targets: ['窗口A'],
  goal: '做一个报价引擎',
  context: '',
  constraints: '',
  acceptance: 'A1: 回归零偏差',
  decisions: '',
  open: '',
};

const readyText = [
  'version: 2',
  '【回读】你要做一个定制家具报价引擎；约束是没有新依赖；验收标准 A1 是 1200 行回归零偏差。',
  '【缺口】',
  '1. 价目表是否包含见光板',
  '2、香槟金的修正系数',
  'STATUS: READY',
].join('\n');

const needInputText = [
  'version: 2',
  '【回读】目标是报价引擎，验收 A1 回归零偏差。',
  '【缺口】1. 高度单位是米还是毫米\n- 无编号的一条也该被收进缺口',
  'STATUS: NEED-INPUT',
].join('\n');

test('parseHandshake reads a READY handshake: status, version, restatement, numbered gaps', () => {
  const hs = parseHandshake(readyText);
  assert.equal(hs.ok, true);
  assert.equal(hs.status, 'ready');
  assert.equal(hs.version, 2);
  assert.ok(hs.restatement.includes('报价引擎'));
  assert.deepEqual(hs.gaps, ['价目表是否包含见光板', '香槟金的修正系数']);
  assert.deepEqual(hs.issues, []);
});

test('parseHandshake accepts Chinese colons and dashes, and keeps unnumbered gap lines', () => {
  const hs = parseHandshake('version：2\n【回读】明白了。\n【缺口】1、高度单位\n- 无编号的一条也该被收进缺口\nSTATUS：NEED-INPUT');
  assert.equal(hs.ok, true);
  assert.equal(hs.status, 'need-input');
  assert.deepEqual(hs.gaps, ['高度单位', '无编号的一条也该被收进缺口']);
});

test('severity tags the receiver brackets inside gap items do not truncate the list', () => {
  const hs = parseHandshake([
    'version: 13',
    '【回读】复述完整。',
    '【缺口】',
    '',
    '我按「是否阻塞开工」排序。',
    '',
    '1. **【阻塞】工作目录里没有插件仓库。** 需要路径。',
    '',
    '2. **【需授权】gh 已登录，但是哪个账号。**',
    '',
    '---',
    '',
    'STATUS: NEED-INPUT',
  ].join('\n'));
  assert.equal(hs.gaps.length, 3, JSON.stringify(hs.gaps));
  assert.ok(hs.gaps[1]!.includes('工作目录里没有插件仓库'));
  assert.ok(hs.gaps[2]!.includes('gh 已登录'));
  assert.ok(!hs.gaps.some((gap) => /^[-*_~.\s]*$/.test(gap)), 'separator residue is not a gap');
  assert.equal(hs.status, 'need-input');
});

test('a bare 无 in the gap block means no gaps', () => {
  const hs = parseHandshake('version: 2\n【回读】清楚。\n【缺口】\n无\nSTATUS: READY');
  assert.equal(hs.status, 'ready');
  assert.deepEqual(hs.gaps, []);
});

test('structurally broken handshakes never pass: each missing block is named', () => {
  const empty = parseHandshake('我觉得没问题，直接开工吧');
  assert.equal(empty.ok, false);
  assert.equal(empty.status, null);
  assert.equal(empty.version, null);
  assert.equal(empty.restatement, '');
  assert.equal(empty.issues.length, 4);

  const noVersion = parseHandshake('【回读】复述了。\n【缺口】无\nSTATUS: READY');
  assert.equal(noVersion.ok, false);
  assert.ok(noVersion.issues[0]!.includes('version'));
});

test('isStaleVersion only flags a concrete wrong version', () => {
  assert.equal(isStaleVersion({ ...parseHandshake(readyText) }, 3), true);
  assert.equal(isStaleVersion({ ...parseHandshake(readyText) }, 2), false);
  const noVersion = parseHandshake('【回读】x\nSTATUS: READY');
  assert.equal(isStaleVersion(noVersion, 2), false); // missing version is an issue, not staleness
});

test('renderAckReply: invalid handshake returns repair instructions instead of a pass', () => {
  const reply = renderAckReply(parseHandshake('直接开工吧'), task, '窗口A');
  assert.ok(reply.startsWith('✗'));
  assert.ok(reply.includes('重来回读'));
  assert.ok(!reply.includes('✓'));
});

test('renderAckReply: gap-free READY confirms and stamps the id@version reference', () => {
  const clean = 'version: 2\n【回读】复述完整。\n【缺口】\n无\nSTATUS: READY';
  assert.equal(needsSenderInput(parseHandshake(clean)), false);
  const reply = renderAckReply(parseHandshake(clean), task, '窗口A');
  assert.ok(reply.startsWith('✓'));
  assert.ok(reply.includes('20261001-a3f2@v2'));
  assert.ok(!reply.includes('⚠'));
});

test('a READY that still lists gaps is demoted to pending answers, not waved through', () => {
  const hs = parseHandshake(readyText);
  assert.equal(hs.status, 'ready');
  assert.equal(needsSenderInput(hs), true);
  const reply = renderAckReply(hs, task, '窗口A', ['Q3', 'Q4']);
  assert.ok(reply.startsWith('△'));
  assert.ok(reply.includes('标了 READY 却列了 2 条缺口'));
  assert.ok(!reply.includes('可以放心让它开工'));
});

test('renderAckReply: READY against an old version is caught, not waved through', () => {
  const reply = renderAckReply(parseHandshake(readyText), { ...task, version: 3 }, '窗口A');
  assert.ok(reply.includes('⚠'));
  assert.ok(reply.includes('v2'));
  assert.ok(reply.includes('v3'));
});

test('renderAckReply: NEED-INPUT lists gaps with the Q ids they were filed under', () => {
  const reply = renderAckReply(parseHandshake(needInputText), task, '窗口A', ['Q3', 'Q4']);
  assert.ok(reply.startsWith('△'));
  assert.ok(reply.includes('G1 → Q3: 高度单位'));
  assert.ok(reply.includes('G2 → Q4'));
  assert.ok(reply.includes('/answer 20261001-a3f2'));
});

test('renderAckReply: NEED-INPUT without listed gaps asks the sender to follow up directly', () => {
  const reply = renderAckReply(parseHandshake('version: 2\n【回读】有些地方没想清楚。\n【缺口】\n无\nSTATUS: NEED-INPUT'), task, '窗口A');
  assert.ok(reply.startsWith('△'));
  assert.ok(reply.includes('没列出具体缺口'));
});
