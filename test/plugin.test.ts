/** Assembly-layer integration tests: the real apply() wired against a scripted
 * mock context, driving the full handshake protocol over a real temp directory.
 * This is the wire coverage the family audit flagged as missing (every P0/P1
 * lived in plugin.ts with zero tests). Pure-layer contracts live in the
 * sibling taskbook/handshake/ledger suites.
 * @module test/plugin.test */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeHarness, fire, fireOk, type Harness } from './harness.ts';

async function mounted(opts?: { agent?: boolean }): Promise<Harness> {
  const harness = makeHarness(opts);
  // dataPath MUST point at the harness temp dir or tests would write the
  // real ~/.dsh/task-forge
  await harness.apply({ dataPath: harness.dataPath });
  return harness;
}

/** Forge a draft and pull its id out of the success text. */
async function forged(harness: Harness, need: string): Promise<string> {
  const text = fireOk(harness, 'forge', need);
  return /任务 id: (\d{8}-[a-z0-9]{4})/.exec(text)![1]!;
}

async function storeOf(harness: Harness): Promise<import('../src/plugin.ts').ForgeStore> {
  const { ForgeStore } = await import('../src/plugin.ts');
  return new ForgeStore(harness.dataPath);
}

test('bad config fails loud naming task-forge, disabled mounts nothing', async () => {
  for (const [bad, fragment] of [
    [{ limit: 0 }, 'limit'],
    [{ maxChars: 10 }, 'maxChars'],
    [{ order: Number.NaN }, 'order'],
  ] as const) {
    const harness = makeHarness();
    await assert.rejects(harness.apply(bad), (error: Error) => {
      assert.match(String(error), /task-forge/);
      assert.match(String(error), new RegExp(fragment));
      return true;
    });
  }
  const off = makeHarness();
  await off.apply({ enabled: false });
  assert.equal(off.commands.length, 0);
  assert.equal(off.tools.length, 0);
  assert.equal(off.sections.length, 0);
});

test('apply wires six commands, the forge_write tool, and the prompt section', async () => {
  const harness = await mounted();
  assert.deepEqual(
    harness.commands.map((command) => command.name).sort(),
    ['ack', 'answer', 'forge', 'forge-done', 'forge-list', 'relay'],
  );
  assert.equal(harness.tool('forge_write').name, 'forge_write');
  const section = harness.sections.find((candidate) => candidate.name === 'task-forge');
  assert.ok(section, 'prompt section registered');
  assert.equal(typeof section!.text(), 'string');
});

test('/forge creates the draft on disk, logs it, and injects the compile instruction', async () => {
  const harness = await mounted();
  const id = await forged(harness, '给插件加个设置面板');

  const store = await storeOf(harness);
  const task = store.loadTask(id)!;
  assert.equal(task.status, 'draft');
  assert.ok(task.goal.includes('设置面板'));
  assert.equal(store.loadStates().events.filter((event) => event.event === 'created').length, 1);

  // compile instruction went to the live session, not the user
  assert.equal(harness.followups.length, 1);
  assert.ok(harness.followups[0]!.text.includes(id));
  assert.ok(harness.followups[0]!.text.includes('forge_write'));
  assert.ok(harness.followups[0]!.text.includes('auto 模式'));
});

test('/forge without a live session falls back to a paste-me instruction', async () => {
  const harness = await mounted({ agent: false });
  const text = fireOk(harness, 'forge', '做一个爬虫');
  assert.ok(text.includes('手动粘贴'));
  assert.equal(harness.followups.length, 0);
  // the draft still exists — the paste path never dead-ends the flow
  assert.match(text, /任务草稿已建：(\d{8}-[a-z0-9]{4})/);
});

test('/forge with interview mode tells the model to ask questions first', async () => {
  const harness = await mounted();
  await forged(harness, '做博客 --mode interview');
  assert.equal(harness.followups.length, 1);
  assert.ok(harness.followups[0]!.text.includes('interview 模式'));
  assert.ok(!harness.followups[0]!.text.includes('auto 模式'));
});

test('/forge rejects empty needs', async () => {
  const harness = await mounted();
  const result = fire(harness, 'forge', '   --mode auto ');
  assert.equal(result.kind, 'error');
  assert.ok(result.text.includes('用法'));
});

test('forge_write compiles fields onto the draft and stamps the ledger', async () => {
  const harness = await mounted();
  const id = await forged(harness, '自动备份插件数据');

  const refusal = await harness.tool('forge_write').execute({
    task_id: id,
    title: '自动备份',
    goal: '每天备份',
    // acceptance missing → validation must refuse to write
  });
  assert.ok(refusal.includes('未落盘'), refusal);

  const ok = await harness.tool('forge_write').execute({
    task_id: id,
    title: '自动备份',
    goal: '每天备份一次数据',
    context: '插件已有导出功能',
    constraints: '不动现有导出格式',
    acceptance: 'A1: 卸载重装后数据可恢复',
    decisions: 'D1: 用文件复制而非 API（官方 API 无全量入口）',
    open: 'Q1: 备份保留几份',
  });
  assert.ok(ok.includes('已落盘'), ok);
  assert.ok(ok.includes(`/relay ${id}`));

  const store = await storeOf(harness);
  const task = store.loadTask(id)!;
  assert.equal(task.title, '自动备份');
  assert.equal(task.goal, '每天备份一次数据');
  assert.equal(task.version, 1); // compile fills v1, it does not bump
  assert.ok(task.decisions.includes('D1'));
  const revised = store.loadStates().events.filter((event) => event.event === 'revised');
  assert.equal(revised.length, 1);
  assert.equal(revised[0]!.note, 'compiled');
});

test('forge_write interview round records questions without compiling', async () => {
  const harness = await mounted();
  const id = await forged(harness, '做发布流水线 --mode interview');
  const reply = await harness.tool('forge_write').execute({ task_id: id, questions: 'Q1: 发到哪个平台\nQ2: 要不要签名' });
  assert.ok(reply.includes('问题清单'), reply);

  const store = await storeOf(harness);
  const task = store.loadTask(id)!;
  assert.equal(task.status, 'draft');
  assert.ok(task.open.includes('发到哪个平台'));
  assert.equal(store.loadStates().events.filter((event) => event.note === 'interview 问题清单').length, 1);
});

test('forge_write refuses unknown task ids', async () => {
  const harness = await mounted();
  const reply = await harness.tool('forge_write').execute({ task_id: '20990101-zzzz', title: 'x' });
  assert.ok(reply.includes('找不到任务'));
});

test('/relay exports the handoff package with the handshake inside', async () => {
  const harness = await mounted();
  const id = await forged(harness, '批量重命名笔记');

  const text = fireOk(harness, 'relay', `${id} --to 窗口A`);
  assert.ok(text.includes('outbox'));
  assert.ok(text.includes('回读'));

  const store = await storeOf(harness);
  const task = store.loadTask(id)!;
  assert.equal(task.status, 'relayed');
  assert.deepEqual(task.targets, ['窗口A']);

  const outbox = readFileSync(join(store.root, 'outbox', `${id}-v1.md`), 'utf8');
  assert.ok(outbox.includes('## 握手指令（HANDSHAKE）'));
  assert.ok(outbox.includes('version: 1'));
  assert.ok(outbox.includes('STATUS: READY'));

  // relaying the same task again adds the second target without duplication
  fireOk(harness, 'relay', id);
  assert.deepEqual(store.loadTask(id)!.targets, ['窗口A', '未命名窗口']);
});

test('/relay errors on unknown ids', async () => {
  const harness = await mounted();
  const result = fire(harness, 'relay', '20990101-zzzz');
  assert.equal(result.kind, 'error');
});

test('/ack on garbage is an invalid handshake: loud refusal, no state change', async () => {
  const harness = await mounted();
  const id = await forged(harness, '写周报机器人');
  fireOk(harness, 'relay', `${id} --to 窗口A`);

  const result = fire(harness, 'ack', `${id} 我看懂了，直接开工吧`);
  assert.equal(result.kind, 'error');
  assert.ok(result.text.includes('✗'));
  assert.ok(result.text.includes('重来回读'));

  const store = await storeOf(harness);
  assert.equal(store.loadTask(id)!.status, 'relayed');
});

test('/ack READY flips the task and stamps the ledger', async () => {
  const harness = await mounted();
  const id = await forged(harness, '写周报机器人');
  fireOk(harness, 'relay', `${id} --to 窗口A`);

  const text = fireOk(harness, 'ack', `${id} version: 1\n【回读】做一个写周报的机器人。\n【缺口】\n无\nSTATUS: READY`);
  assert.ok(text.includes('✓'), text);
  assert.ok(text.includes(`${id}@v1`));

  const store = await storeOf(harness);
  assert.equal(store.loadTask(id)!.status, 'ready');
});

test('a self-granted READY that still lists gaps is demoted, not waved through', async () => {
  const harness = await mounted();
  const id = await forged(harness, '写周报机器人');
  fireOk(harness, 'relay', `${id} --to 窗口A`);

  const text = fireOk(harness, 'ack', `${id} version: 1\n【回读】做一个写周报的机器人。缺口我都自己定了。\n【缺口】\n1. 周报发到哪个邮箱\nSTATUS: READY`);
  assert.ok(text.includes('△'), text); // demoted to need-input, not ✓
  assert.ok(text.includes('G1 → Q1'));

  const store = await storeOf(harness);
  const demoted = store.loadTask(id)!;
  assert.equal(demoted.status, 'relayed');
  assert.ok(demoted.open.includes('Q1 (来自对方回读): 周报发到哪个邮箱'));
});

test('/ack against an old version never passes as current', async () => {
  const harness = await mounted();
  const id = await forged(harness, '写周报机器人');
  fireOk(harness, 'relay', `${id} --to 窗口A`);
  fireOk(harness, 'ack', `${id} version: 1\n【回读】懂了。\n【缺口】\n1. 周报发到哪\nSTATUS: NEED-INPUT`);
  fireOk(harness, 'answer', `${id} Q1 发到群邮件`);

  // stale receiver still quoting v1
  const text = fireOk(harness, 'ack', `${id} version: 1\n【回读】懂了。\n【缺口】\n无\nSTATUS: READY`);
  assert.ok(text.includes('⚠'), text);
  assert.ok(text.includes('v1'));
  assert.ok(text.includes('重新 relay'));

  const store = await storeOf(harness);
  assert.equal(store.loadTask(id)!.status, 'relayed'); // NOT ready
});

test('/ack NEED-INPUT files the gaps as numbered Q lines, /answer resolves them with a version bump', async () => {
  const harness = await mounted();
  const id = await forged(harness, '写周报机器人');
  fireOk(harness, 'relay', `${id} --to 窗口A`);

  const ackText = fireOk(harness, 'ack', `${id} version: 1\n【回读】做一个写周报的机器人。\n【缺口】\n1. 周报覆盖哪个时间范围\n2. 发给谁\nSTATUS: NEED-INPUT`);
  assert.ok(ackText.includes('△'), ackText);
  assert.ok(ackText.includes('G1 → Q1: 周报覆盖哪个时间范围'));
  assert.ok(ackText.includes('G2 → Q2'));
  assert.ok(ackText.includes(`/answer ${id}`));

  const store = await storeOf(harness);
  const gapped = store.loadTask(id)!;
  assert.ok(gapped.open.includes('Q1 (来自对方回读): 周报覆盖哪个时间范围'));
  assert.ok(gapped.open.includes('Q2 (来自对方回读): 发给谁'));

  const answerText = fireOk(harness, 'answer', `${id} Q1 最近一周`);
  assert.ok(answerText.includes('v2'), answerText);
  assert.ok(answerText.includes('重新 /relay'));

  const revised = store.loadTask(id)!;
  assert.equal(revised.version, 2);
  assert.ok(revised.decisions.includes('D1（原 Q1 已答）: 最近一周'));
  assert.ok(!revised.open.includes('Q1 '));
  assert.ok(revised.open.includes('Q2'));

  // answering a gap that does not exist lists what does
  const miss = fire(harness, 'answer', `${id} Q9 瞎答`);
  assert.equal(miss.kind, 'error');
  assert.ok(miss.text.includes('Q2'));
});

test('/forge-list renders the ledger, /forge-done retires tasks from injection', async () => {
  const empty = await mounted();
  assert.ok(empty.command('forge-list').handler({}).text.includes('空的'));

  const harness = await mounted();
  const id = await forged(harness, '退出登录清理器');
  fireOk(harness, 'relay', `${id} --to 窗口B`);

  const list = fire(harness, 'forge-list').text;
  assert.ok(list.includes(`${id}@v1 [relayed]`));
  assert.ok(list.includes('窗口B'));

  // the prompt section shows the live task
  assert.ok(harness.sectionText().includes(id));
  assert.ok(harness.sectionText().includes('进行中任务'));

  const doneText = fireOk(harness, 'forge-done', id);
  assert.ok(doneText.includes('已标记完成'));

  const store = await storeOf(harness);
  assert.equal(store.loadTask(id)!.status, 'done');
  // done tasks drop out of the section but stay visible in the ledger view
  assert.ok(!harness.sectionText().includes(id));
  assert.ok(fire(harness, 'forge-list').text.includes('[done]'));
});
