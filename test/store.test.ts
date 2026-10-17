import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ForgeStore } from '../src/plugin.ts';
import { makeTaskId, parseTaskMarkdown, type TaskBook } from '../src/taskbook.ts';

function freshStore(): ForgeStore {
  const root = mkdtempSync(join(tmpdir(), 'task-forge-test-'));
  return new ForgeStore(root);
}

const baseTask = (id: string, over: Partial<TaskBook> = {}): TaskBook => ({
  v: 1,
  id,
  version: 1,
  status: 'draft',
  title: '测试任务书',
  mode: 'auto',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  targets: [],
  goal: '做一个测试任务',
  context: '',
  constraints: '',
  acceptance: 'A1 通过',
  decisions: '',
  open: '',
  ...over,
});

test('taskPath 拒绝越界与非格式 id：模型可控的 task_id 到不了文件系统', () => {
  const store = freshStore();
  for (const bad of ['../../escape', '20261001-..x!', '', 'x', '2026-1001-a3f2', '../secret']) {
    assert.throws(() => store.taskPath(bad), /非法任务编号/, `id "${bad}" 应被拒绝`);
  }
  assert.equal(store.taskPath('20261001-a3f2'), join(store.root, 'tasks', '20261001-a3f2', 'task.md'));
});

test('saveTask/loadTask roundtrip 保住全部字段', () => {
  const store = freshStore();
  const now = new Date();
  const task = baseTask(makeTaskId(now), { targets: [{ name: '窗口A' }, { name: '窗口B' }], open: 'Q1 高度单位是什么' });
  store.saveTask(task);
  const disk = readFileSync(join(store.root, 'tasks', task.id, 'task.md'), 'utf8');
  assert.match(disk, /^---\n/);
  const parsed = parseTaskMarkdown(disk);
  assert.deepEqual(parsed.issues, []);
  const loaded = store.loadTask(task.id);
  assert.ok(loaded);
  assert.equal(loaded.version, task.version);
  assert.deepEqual(loaded.targets, [{ name: '窗口A' }, { name: '窗口B' }]);
  assert.ok(loaded.open.includes('Q1'));
});

test('loadTask 对损坏任务书抛出带定位的错误', () => {
  const store = freshStore();
  mkdirSync(join(store.root, 'tasks', '20261001-b0g9'), { recursive: true });
  writeFileSync(join(store.root, 'tasks', '20261001-b0g9', 'task.md'), '这就是一段普通文字，连 frontmatter 都没有', 'utf8');
  assert.throws(() => store.loadTask('20261001-b0g9'), /损坏|无法解析/);
  rmSync(store.root, { recursive: true, force: true });
});

test('queue 串行化并发读改写：20 个并发 targets 增补一个不丢', async () => {
  const store = freshStore();
  store.saveTask(baseTask('20261001-a3f2'));
  const operations = Array.from({ length: 20 }, (_, index) =>
    store.queue(() => {
      const current = store.loadTask('20261001-a3f2')!;
      if (!current.targets.some((entry) => entry.name === `窗口${index}`)) current.targets.push({ name: `窗口${index}` });
      store.saveTask(current);
      store.appendEvent({ ts: current.updatedAt, task: current.id, event: 'relayed', version: 1, target: `窗口${index}` });
      return index;
    }),
  );
  const done = await Promise.all(operations);
  assert.deepEqual(done, Array.from({ length: 20 }, (_, index) => index));
  const final = store.loadTask('20261001-a3f2')!;
  assert.equal(final.targets.length, 20);
  const ledger = readFileSync(store.ledgerPath, 'utf8').trim().split('\n');
  assert.equal(ledger.length, 20);
});

test('queue 单个操作失败不断链：后续操作照常执行', async () => {
  const store = freshStore();
  const boom = store
    .queue(() => {
      throw new Error('第一个操作炸了');
    })
    .catch((error: unknown) => `caught: ${(error as Error).message}`);
  assert.equal(await boom, 'caught: 第一个操作炸了');
  const answer = await store.queue(() => '仍然活着');
  assert.equal(answer, '仍然活着');
});

test('queue 保持确定顺序：先进队的先执行', async () => {
  const store = freshStore();
  const order: string[] = [];
  await Promise.all([
    store.queue(() => (order.push('first'), 'first')),
    store.queue(() => (order.push('second'), 'second')),
  ]);
  assert.deepEqual(order, ['first', 'second']);
});

test('appendEvent 清洗 note 换行，永远单行 JSONL', () => {
  const store = freshStore();
  store.appendEvent({ ts: '2026-10-01T00:00:00.000Z', task: '20261001-a3f2', event: 'created', version: 1, note: '第一行\n第二行' });
  const line = readFileSync(store.ledgerPath, 'utf8').trim();
  assert.equal(line.includes('\n'), false);
  const parsed = JSON.parse(line) as { note: string };
  assert.equal(parsed.note, '第一行 第二行');
});
