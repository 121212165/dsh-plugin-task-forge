/** Assembly-layer integration tests: the real apply() wired against a scripted
 * mock context, driving the full handshake protocol over a real temp directory.
 * This is the wire coverage the family audit flagged as missing (every P0/P1
 * lived in plugin.ts with zero tests). Pure-layer contracts live in the
 * sibling taskbook/handshake/ledger suites.
 * @module test/plugin.test */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';import { join } from 'node:path';

import { makeHarness, fire, fireOk, toolResult, type Harness } from './harness.ts';
import { parseTaskMarkdown } from '../src/taskbook.ts';

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

test('apply wires eight commands, the forge_write tool, and the prompt section', async () => {
  const harness = await mounted();
  assert.deepEqual(
    harness.commands.map((command) => command.name).sort(),
    ['ack', 'answer', 'forge', 'forge-done', 'forge-list', 'forge-note', 'forge-show', 'relay'],
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
  assert.deepEqual(task.targets, [{ name: '窗口A' }]);

  const outbox = readFileSync(join(store.root, 'outbox', `${id}-v1.md`), 'utf8');
  assert.ok(outbox.includes('## 握手指令（HANDSHAKE）'));
  assert.ok(outbox.includes('version: 1'));
  assert.ok(outbox.includes('STATUS: READY'));

  // relaying the same task again adds the second target without duplication
  fireOk(harness, 'relay', id);
  assert.deepEqual(store.loadTask(id)!.targets, [{ name: '窗口A' }, { name: '未命名窗口' }]);
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

test('compile-pending tasks ride the system-prompt section until compiled', async () => {
  const harness = await mounted();
  const id = await forged(harness, '给终端加个倒计时');

  // draft without compile: section demands the model compile it immediately
  const pending = harness.sectionText();
  assert.ok(pending.includes('待编译任务'), pending);
  assert.ok(pending.includes(id));
  assert.ok(pending.includes('forge_write'));
  assert.ok(pending.includes('给终端加个倒计时'));

  // after forge_write compiles it, the demand disappears
  await harness.tool('forge_write').execute({
    task_id: id,
    title: '倒计时',
    goal: '会话开始倒计时',
    acceptance: 'A1: 启动时响一声',
  });
  assert.ok(!harness.sectionText().includes('待编译任务'));

  // relaying an uncompiled draft also clears the demand (user chose raw handoff)
  const harness2 = await mounted();
  const id2 = await forged(harness2, '另一个需求');
  fireOk(harness2, 'relay', `${id2} --to 窗口X`);
  assert.ok(!harness2.sectionText().includes('待编译任务'));
});

test('task references accept id prefixes and unique title substrings, not just exact ids', async () => {
  const harness = await mounted();
  const id = await forged(harness, '给 obsidian 写一个自动发布流水线');
  const prefix = id.slice(0, 10);

  // id prefix resolves
  fireOk(harness, 'relay', `${prefix} --to 窗口P`);
  assert.ok(harness.sectionText().includes(id) || fire(harness, 'forge-list').text.includes(id));

  // unique title substring resolves ('自动发布' matches this task's title)
  fireOk(harness, 'forge-done', '自动发布');
  const store = await storeOf(harness);
  assert.equal(store.loadTask(id)!.status, 'done');

  // ambiguous and missing tokens fail with guidance
  const missing = fire(harness, 'relay', '20990101-zzzz');
  assert.equal(missing.kind, 'error');
});

test('/forge-list renders the ledger, /forge-done retires tasks from injection', async () => {
  const empty = await mounted();
  assert.ok(empty.command('forge-list').handler({}).text.includes('空的'));

  const harness = await mounted();
  const id = await forged(harness, '退出登录清理器');
  fireOk(harness, 'relay', `${id} --to 窗口B`);

  const list = fire(harness, 'forge-list').text;
  assert.ok(list.includes(`${id}@v1`));
  assert.ok(list.includes('[待回读]'));
  assert.ok(list.includes('窗口B○'), list);
  assert.ok(list.includes('▸ 等接收方回读'));

  // the prompt section shows the live task
  assert.ok(harness.sectionText().includes(id));
  assert.ok(harness.sectionText().includes('进行中任务'));

  const doneText = fireOk(harness, 'forge-done', id);
  assert.ok(doneText.includes('已标记完成'));

  const store = await storeOf(harness);
  assert.equal(store.loadTask(id)!.status, 'done');
  // done tasks drop out of the section but stay visible in the ledger view
  assert.ok(!harness.sectionText().includes(id));
  assert.ok(fire(harness, 'forge-list').text.includes('[已完成]'));
});

test('interview closes its own loop: questions → /answer ×N → recompiled automatically', async () => {
  const harness = await mounted();
  const id = await forged(harness, '做发布流水线 --mode interview');

  const asked = await harness.tool('forge_write').execute({ task_id: id, questions: 'Q1: 发到哪个平台\nQ2: 要不要签名' });
  assert.ok(asked.includes('/answer'), asked);
  assert.ok(asked.includes('答完最后一个 Q'), asked);

  const store = await storeOf(harness);
  assert.equal(store.loadTask(id)!.phase, 'awaiting-answers');
  assert.equal(harness.followups.length, 1, 'asking questions is not a compile round');

  const first = fireOk(harness, 'answer', `${id} Q1 内网 registry`);
  assert.ok(first.includes('还剩 Q2'), first);
  assert.equal(harness.followups.length, 1);

  const last = fireOk(harness, 'answer', `${id} Q2 要签名`);
  assert.ok(last.includes('问题已全部答完'), last);
  assert.equal(harness.followups.length, 2, 'the compiler turn is re-injected on the last answer');
  const second = harness.followups[1]!.text;
  assert.ok(second.includes('任务编译'), second);
  assert.ok(second.includes('interview 第二轮'), second);
  assert.ok(second.includes('forge_write'), second);

  const compiled = store.loadTask(id)!;
  assert.equal('phase' in compiled, false, 'the loop cannot fire twice on the same version');
  assert.equal(compiled.version, 3);
  assert.ok(compiled.decisions.includes('D1（原 Q1 已答）: 内网 registry'));
  assert.ok(compiled.decisions.includes('D2（原 Q2 已答）: 要签名'));
  assert.equal(compiled.open, '');
  assert.equal(store.loadStates().events.filter((event) => event.note === 'interview 答完 → 重新编译').length, 1);

  // answering an already-answered gap does not inject a third compile turn
  assert.equal(fire(harness, 'answer', `${id} Q1 再答一次`).kind, 'error');
  assert.equal(harness.followups.length, 2);
});

test('without a live session the interview loop hands over a paste-me compile block', async () => {
  const harness = await mounted({ agent: false });
  const id = await forged(harness, '做同步器 --mode interview');
  await harness.tool('forge_write').execute({ task_id: id, questions: 'Q1: 同步方向' });
  const text = fireOk(harness, 'answer', `${id} Q1 单向拉取`);
  assert.ok(text.includes('问题已全部答完'), text);
  assert.ok(text.includes('手动粘贴'), text);
});

test('the compiler cannot drop a user answer: forge_write restores it and says so', async () => {
  const harness = await mounted();
  const id = await forged(harness, '自动对账');
  await harness.tool('forge_write').execute({
    task_id: id,
    title: '自动对账',
    goal: '每日对账',
    acceptance: 'A1: 差异清单可导出',
    decisions: 'D1: 用银行流水做基准',
    open: 'Q1: 差异超阈值要不要拦',
  });
  fireOk(harness, 'answer', `${id} Q1 超过 1% 就拦`);

  // round two rewrites DECISIONS and forgets the answer
  const reply = await harness.tool('forge_write').execute({
    task_id: id,
    goal: '每日自动对账并出差异清单',
    acceptance: 'A1: 差异清单可导出',
    decisions: 'D1: 用银行流水做基准',
  });
  assert.ok(reply.includes('已原样补回'), reply);

  const store = await storeOf(harness);
  assert.ok(store.loadTask(id)!.decisions.includes('D2（原 Q1 已答）: 超过 1% 就拦'));
});

test('/relay --to ide:<tool> drops a copy the editor can open itself', async () => {
  const harness = await mounted();
  const id = await forged(harness, '给插件加设置面板');
  await harness.tool('forge_write').execute({ task_id: id, goal: '加一个设置面板', acceptance: 'A1: 改完下一轮即生效' });

  const text = fireOk(harness, 'relay', `${id} --to ide:zcode`);
  assert.ok(text.includes('派发目标 ide:zcode'), text);
  assert.ok(text.includes('不自动注入'), text);
  assert.ok(text.includes('握手指令'), text);

  const store = await storeOf(harness);
  assert.deepEqual(store.loadTask(id)!.targets, [{ name: 'ide:zcode' }]);
  // the project copy is byte-identical to the outbox package, so either one parses back
  const ref = join(harness.dataPath, 'hub', 'tasks', `${id}-v1.md`);
  const copied = readFileSync(ref, 'utf8');
  assert.equal(copied, readFileSync(join(store.root, 'outbox', `${id}-v1.md`), 'utf8'));
  assert.deepEqual(parseTaskMarkdown(copied).issues, []);

  const unknown = fire(harness, 'relay', `${id} --to ide:notreal`);
  assert.equal(unknown.kind, 'error');
  assert.ok(unknown.text.includes('ide:zcode'), unknown.text);

  // a bare window name keeps the v0.1 paste path, and says nothing about IDEs
  const plain = fireOk(harness, 'relay', `${id} --to 窗口A`);
  assert.ok(plain.includes('粘贴给「窗口A」'), plain);
  assert.ok(!plain.includes('派发目标'));
});

test('/ack --to records which window read back which version', async () => {
  const harness = await mounted();
  const id = await forged(harness, '写周报机器人');
  fireOk(harness, 'relay', `${id} --to 窗口A`);
  fireOk(harness, 'relay', `${id} --to 窗口B`);

  const ambiguous = fireOk(harness, 'ack', `${id} version: 1\n【回读】懂了。\n【缺口】\n无\nSTATUS: READY`);
  assert.ok(ambiguous.includes('--to'), ambiguous);
  const holders = async (): Promise<Record<string, number | undefined>> =>
    Object.fromEntries((await storeOf(harness)).loadTask(id)!.targets.map((target) => [target.name, target.ackedVersion]));
  assert.deepEqual(await holders(), { '窗口A': undefined, '窗口B': undefined }, 'an ambiguous ack credits no window');

  const text = fireOk(harness, 'ack', `${id} --to 窗口A version: 1\n【回读】懂了。\n【缺口】\n无\nSTATUS: READY`);
  assert.ok(text.includes('✓ 窗口A'), text);

  const store = await storeOf(harness);
  const task = store.loadTask(id)!;
  assert.deepEqual(task.targets, [
    { name: '窗口A', ackedAt: task.targets[0]!.ackedAt, ackedVersion: 1 },
    { name: '窗口B' },
  ]);
  assert.ok(Number.isFinite(Date.parse(task.targets[0]!.ackedAt!)));
  assert.ok(fire(harness, 'forge-list').text.includes('窗口A✓v1 / 窗口B○'), fire(harness, 'forge-list').text);

  // answering a gap that does not exist still renumbers from the highest number ever used
  fireOk(harness, 'ack', `${id} --to 窗口B version: 1\n【回读】懂了。\n【缺口】\n1. 发给谁\nSTATUS: NEED-INPUT`);
  assert.ok(store.loadTask(id)!.open.includes('Q1 (来自对方回读): 发给谁'), store.loadTask(id)!.open);
  fireOk(harness, 'answer', `${id} Q1 发给部门群`);
  fireOk(harness, 'ack', `${id} --to 窗口B version: 2\n【回读】懂了。\n【缺口】\n1. 周报格式\nSTATUS: NEED-INPUT`);
  assert.ok(store.loadTask(id)!.open.includes('Q2 (来自对方回读): 周报格式'), store.loadTask(id)!.open);

  // a new revision leaves 窗口A confirmed against an older version, not the current one
  const clean = fireOk(harness, 'ack', `${id} --to 窗口A version: 2\n【回读】懂了。\n【缺口】\n无\nSTATUS: READY`);
  assert.ok(clean.includes('✓ 窗口A'), clean);
  assert.equal(store.loadTask(id)!.status, 'ready');
  assert.ok(fire(harness, 'forge-list').text.includes('窗口A✓v2'), fire(harness, 'forge-list').text);

  fireOk(harness, 'answer', `${id} Q2 周一早报发出`);
  assert.equal(store.loadTask(id)!.version, 3);
  assert.ok(fire(harness, 'forge-list').text.includes('窗口A◐v2'), fire(harness, 'forge-list').text);

  // and a read-back that lists gaps is not a green light, so nobody gets stamped
  const gapped = fireOk(harness, 'ack', `${id} --to 窗口B version: 3\n【回读】懂了。\n【缺口】\n1. 要不要抄送\nSTATUS: NEED-INPUT`);
  assert.ok(gapped.includes('△'), gapped);
  assert.equal(store.loadTask(id)!.targets[1]!.ackedVersion, undefined);
});

test('forge_write presents a card that names the task and the file it touches', async () => {
  const harness = await mounted();
  const id = await forged(harness, '导出客户名单');
  const tool = harness.tool('forge_write');
  assert.equal(typeof tool.presentCall, 'function');
  assert.equal(typeof tool.presentResult, 'function');

  const compiling = tool.presentCall!({ task_id: id, goal: '导出客户名单为 CSV' });
  assert.equal(compiling.card, 'generic');
  assert.equal(compiling.kind, 'edit');
  assert.equal(compiling.title, `写入任务书 ${id}`);
  assert.deepEqual(compiling.locations, [{ path: join((await storeOf(harness)).taskPath(id)) }]);

  const asking = tool.presentCall!({ task_id: id, questions: 'Q1: 导出给谁' });
  assert.ok(asking.title.includes('interview 问题清单'), asking.title);

  const reply = await tool.execute({ task_id: id, goal: '导出客户名单为 CSV', acceptance: 'A1: 一万行不超时' });
  const done = tool.presentResult!({ task_id: id, goal: '导出客户名单为 CSV', acceptance: 'A1: 一万行不超时' }, reply);
  assert.equal(done.card, 'generic');
  assert.equal(done.title, `✓ 任务书 ${id}@v1`);
  assert.equal(done.content![0]!.text, reply);

  // a refusal must not wear a green title
  const refused = tool.presentResult!({ task_id: id }, '字段没过校验，未落盘：\n- acceptance 不能为空');
  assert.equal(refused.title, '✗ 任务书字段没过校验');
});

test('/relay warns when quota says the budget is already hot', async () => {
  const hot = {
    updatedAt: new Date().toISOString(),
    currency: 'CNY',
    budgetTokens: 100_000,
    maxSessionTokens: 85_000,
    maxSessionRatio: 0.85,
    nextTurnEstTokens: 30_000,
    todayTokens: 90_000,
    todayCostMicros: 12_345,
    sessions: 1,
  };

  const harness = makeHarness();
  const summaryPath = join(harness.dataPath, 'summary.json');
  writeFileSync(summaryPath, JSON.stringify(hot), 'utf8');
  await harness.apply({ dataPath: harness.dataPath, quotaSummaryPath: summaryPath });

  const id = /任务 id: (\d{8}-[a-z0-9]{4})/.exec(fireOk(harness, 'forge', '跑一轮全量回归'))![1]!;
  const text = fireOk(harness, 'relay', `${id} --to 窗口A`);
  assert.ok(text.includes('⚠ 预算已用 85%'), text);
  assert.ok(text.includes('收到回读后'), text);
  assert.ok(text.indexOf('交接包已导出') < text.indexOf('⚠'), 'the warning comes after the handoff, not instead of it');

  // a cold meter, a stale file, and no file at all all say nothing
  fireOk(harness, 'relay', `${id} --to 窗口B`);
  writeFileSync(summaryPath, JSON.stringify({ ...hot, maxSessionRatio: 0.2, maxSessionTokens: 20_000 }), 'utf8');
  assert.ok(!fireOk(harness, 'relay', `${id} --to 窗口C`).includes('预算'));
  writeFileSync(summaryPath, JSON.stringify({ ...hot, updatedAt: '2026-01-01T00:00:00.000Z' }), 'utf8');
  assert.ok(!fireOk(harness, 'relay', `${id} --to 窗口D`).includes('预算'), 'stale readings are not this session\'s');
  writeFileSync(summaryPath, '{ half-written', 'utf8');
  assert.ok(!fireOk(harness, 'relay', `${id} --to 窗口E`).includes('预算'));

  const missing = makeHarness();
  await missing.apply({ dataPath: missing.dataPath, quotaSummaryPath: join(missing.dataPath, 'never-written.json') });
  const otherId = /任务 id: (\d{8}-[a-z0-9]{4})/.exec(fireOk(missing, 'forge', '没有 quota 也要能交接'))![1]!;
  const quiet = fireOk(missing, 'relay', `${otherId} --to 窗口A`);
  assert.ok(quiet.includes('交接包已导出'), quiet);
  assert.ok(!quiet.includes('预算'), quiet);
});

test('/relay prints a token-cost estimate line after the handoff lines', async () => {
  const harness = makeHarness();
  await harness.apply({ dataPath: harness.dataPath, quotaHistoryPath: join(harness.dataPath, 'absent-history.json') });
  const id = /任务 id: (\d{8}-[a-z0-9]{4})/.exec(fireOk(harness, 'forge', '给插件加设置面板'))![1]!;

  const text = fireOk(harness, 'relay', `${id} --to 窗口A`);
  const line = text.split('\n').find((candidate) => candidate.includes('预计烧'));
  assert.ok(line, text);
  assert.ok(line!.includes('tok（编译'), line);
  assert.ok(text.indexOf('收到回读后') < text.indexOf('预计烧'), 'the estimate comes after the handoff lines');

  // no history yet: honest degradation, the line says it is a heuristic, not a measurement
  assert.ok(line!.includes('启发式'), line);
  assert.ok(line!.includes('无观测'), line);
});

test('quota history grounds the estimate and it still sits before the budget warning', async () => {
  const harness = makeHarness();
  const historyPath = join(harness.dataPath, 'history.json');
  writeFileSync(historyPath, JSON.stringify({
    s1: [
      { input: 1000, output: 5000, cacheRead: 0 },
      { input: 2000, output: 7000, cacheRead: 1000 },
      { input: 500, output: 9000, cacheRead: 0 },
    ],
  }), 'utf8');
  const summaryPath = join(harness.dataPath, 'summary.json');
  writeFileSync(summaryPath, JSON.stringify({
    updatedAt: new Date().toISOString(), currency: 'CNY', budgetTokens: 100_000, maxSessionTokens: 85_000,
    maxSessionRatio: 0.85, nextTurnEstTokens: 30_000, todayTokens: 90_000, todayCostMicros: 12_345, sessions: 1,
  }), 'utf8');
  await harness.apply({ dataPath: harness.dataPath, quotaHistoryPath: historyPath, quotaSummaryPath: summaryPath });
  const id = /任务 id: (\d{8}-[a-z0-9]{4})/.exec(fireOk(harness, 'forge', '跑一轮全量回归'))![1]!;

  const text = fireOk(harness, 'relay', `${id} --to 窗口A`);
  assert.ok(text.includes('基于 3 步观测'), text);
  assert.ok(!text.split('\n').some((candidate) => candidate.includes('启发式')), 'observed history is not labelled heuristic');
  assert.ok(text.indexOf('预计烧') < text.indexOf('⚠'), 'estimate before the budget warning');
});

test('a corrupt history file changes only the wording, never the command result', async () => {
  const harness = makeHarness();
  const historyPath = join(harness.dataPath, 'history.json');
  writeFileSync(historyPath, '{ half-written', 'utf8');
  await harness.apply({ dataPath: harness.dataPath, quotaHistoryPath: historyPath });
  const id = /任务 id: (\d{8}-[a-z0-9]{4})/.exec(fireOk(harness, 'forge', '写周报机器人'))![1]!;

  const relay = fire(harness, 'relay', `${id} --to 窗口A`);
  assert.equal(relay.kind, 'success', 'half-written history cannot crash the handoff');
  assert.ok(relay.text.includes('无观测'), relay.text);

  // garbage that parses but carries no usable steps behaves the same
  writeFileSync(historyPath, JSON.stringify({ s1: 'not an array', s2: [{ input: -1, output: 2, cacheRead: 0 }] }), 'utf8');
  const again = fire(harness, 'relay', `${id} --to 窗口B`);
  assert.equal(again.kind, 'success');
  assert.ok(again.text.includes('启发式'), again.text);
});

test('/forge-list shows a compact cost estimate per task', async () => {
  const harness = await mounted();
  const id = await forged(harness, '重建计费子系统'.repeat(160));
  fireOk(harness, 'relay', `${id} --to 窗口A`);
  const list = fire(harness, 'forge-list').text;
  assert.match(list, /预估 \d+(?:\.\d+)?k–\d+(?:\.\d+)?k/, list);
});

test('a bad quotaHistoryPath fails startup naming task-forge', async () => {
  for (const bad of ['', '   ', 'has\nnewline']) {
    const harness = makeHarness();
    await assert.rejects(harness.apply({ quotaHistoryPath: bad }), (error: Error) => {
      assert.match(String(error), /task-forge/);
      assert.match(String(error), /quotaHistoryPath/);
      return true;
    });
  }
});

test('/forge-show prints the full book: status summary line, acceptance ids, handshake', async () => {
  const harness = await mounted();
  const id = await forged(harness, '给图片查看器加取色功能');
  const store = await storeOf(harness);
  const task = store.loadTask(id)!;
  task.acceptance = 'A1 点击画布取色\nA2 色值入剪贴板';
  task.context = '已有 canvas 渲染层';
  store.saveTask(task);

  const text = fireOk(harness, 'forge-show', id);
  // top line is a one-line status summary, book follows in full
  assert.ok(text.startsWith(`任务书 ${id}@v1 [草稿] · 窗口: 还没交接过`), `summary line missing: ${text.slice(0, 80)}`);
  assert.ok(text.includes('A1 点击画布取色'), 'acceptance ids must appear');
  assert.ok(text.includes('## 握手指令（HANDSHAKE）'), 'handshake rides along');
});

test('/forge-show accepts id prefixes and title substrings, errors loudly otherwise', async () => {
  const harness = await mounted();
  await forged(harness, '给图片查看器加取色功能');

  const byTitle = fireOk(harness, 'forge-show', '取色');
  assert.ok(byTitle.includes('# 任务书 '));
  const byPrefix = fireOk(harness, 'forge-show', (await storeOf(harness)).listTasks()[0]!.id.slice(0, 10));
  assert.ok(byPrefix.includes('## 背景（CONTEXT）'));

  const missing = fire(harness, 'forge-show', '20990101-zzzz');
  assert.equal(missing.kind, 'error');
  assert.ok(missing.text.includes('/forge-list'));
  const empty = fire(harness, 'forge-show', '');
  assert.equal(empty.kind, 'error');
});

test('/forge-note appends a dated context line, keeps the version, and logs a noted event', async () => {
  const harness = await mounted();
  const id = await forged(harness, '给图片查看器加取色功能');
  // compile it first so the note lands on a real book
  await toolResult(harness, 'forge_write', { task_id: id, goal: '取色', acceptance: 'A1 取色' });

  const out = fireOk(harness, 'forge-note', `${id} 配色以 Figma 为准`);
  assert.ok(out.includes('版本保持 v1'), out);

  const task = (await storeOf(harness)).loadTask(id)!;
  assert.equal(task.version, 1);
  assert.ok(task.context.endsWith('- ' + new Date().toISOString().slice(0, 10) + ' 配色以 Figma 为准'), task.context);

  const list = fire(harness, 'forge-list').text;
  assert.ok(list.includes('备注 1'), list);

  // roundtrip: the relayed copy parses back clean with the note inside
  const relayed = fireOk(harness, 'relay', id);
  const store = await storeOf(harness);
  const parsed = parseTaskMarkdown(readFileSync(join(harness.dataPath, 'outbox', `${id}-v1.md`), 'utf8'));
  assert.equal(parsed.issues.length, 0);
  assert.ok(parsed.task!.context.includes('配色以 Figma 为准'));
});

test('/forge-note never wakes compile-pending: a compiled book stays out of the section', async () => {
  const harness = await mounted();
  const id = await forged(harness, '给图片查看器加取色功能');
  await toolResult(harness, 'forge_write', { task_id: id, goal: '取色', acceptance: 'A1 取色' });
  fireOk(harness, 'forge-note', `${id} 先看老仓库`);
  assert.ok(!harness.sectionText().includes('待编译'), harness.sectionText());

  // a still-uncompiled draft stays pending exactly once — a note must not duplicate it
  const second = await forged(harness, '第二号任务');
  fireOk(harness, 'forge-note', `${second} 备注一条`);
  const pending = harness.sectionText().split('待编译任务 ' + second).length - 1;
  assert.equal(pending, 1);
});

test('/forge-note errors loudly on unknown ids and empty note text', async () => {
  const harness = await mounted();
  const missing = fire(harness, 'forge-note', '20990101-zzzz hi');
  assert.equal(missing.kind, 'error');
  const id = await forged(harness, '给图片查看器加取色功能');
  const noText = fire(harness, 'forge-note', id);
  assert.equal(noText.kind, 'error');
  assert.ok(noText.text.includes('用法'), noText.text);
});
