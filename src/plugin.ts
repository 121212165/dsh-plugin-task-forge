/**
 * dsh wiring for task-forge: compile a rough need into a versioned task book,
 * relay it as a self-contained markdown file, and let the read-back handshake
 * (see taskbook.ts HANDSHAKE_TEXT) make the transfer lossless. The ledger is
 * the authority for who holds which version; the system-prompt section reads
 * it live so new windows know what is in flight.
 */
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { brandString } from '@deepseek-ai/dsh-brand';
import type {} from '@deepseek-ai/dsh-commands';
import type {} from '@deepseek-ai/dsh-system-prompt';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  applyAnswer,
  deriveTitle,
  forgeCardTitle,
  makeTaskId,
  outboxName,
  parseTaskMarkdown,
  preservedAnswers,
  remainingGapIds,
  renderCompileInstruction,
  renderTaskMarkdown,
  STATUS_LABEL,
  targetNames,
  targetSummary,
  validateTask,
  withNote,
  withPhase,
  withTarget,
  withTargetAcked,
  type ForgeMode,
  type TaskBook,
} from './taskbook.ts';
import { isStaleVersion, needsSenderInput, parseHandshake, renderAckReply } from './handshake.ts';
import { eventLine, foldStates, parseLedger, renderForgeList, renderSection, type TaskDetail } from './ledger.ts';
import { IDE_TARGETS, hubReferencePath, ideTargetFor, parseIdeTarget, renderIdeRelayNote } from './ide-targets.ts';
import { DEFAULT_SUMMARY_PATH, budgetWarningLine, parseQuotaSummary } from './quota-contract.ts';
import { DEFAULT_HISTORY_PATH, estimateTaskCost, parseHistory, renderCostCompact, renderCostLine, type PriceInput, type StepUsage } from './task-cost.ts';

export const name = 'task-forge';
export const inject = ['commands', 'tools', 'systemPrompt', 'llm', 'agents'];

export interface Config {
  enabled: boolean;
  dataPath?: string;
  /** where a `--to ide:*` copy lands, relative to the session cwd */
  hubPath: string;
  /** quota's published budget contract, read before handing work to another window */
  quotaSummaryPath: string;
  /** quota's published per-step history, read to ground the task cost estimate */
  quotaHistoryPath: string;
  limit: number;
  maxChars: number;
  order: number;
}

export const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  dataPath: Schema.string(),
  hubPath: Schema.string().default('.hub'),
  quotaSummaryPath: Schema.string().default(DEFAULT_SUMMARY_PATH),
  quotaHistoryPath: Schema.string().default(DEFAULT_HISTORY_PATH),
  limit: Schema.natural().default(8),
  maxChars: Schema.natural().default(900),
  order: Schema.number().default(690),
});

export function expandHome(path: string): string {
  return path.startsWith('~') ? join(homedir(), path.slice(1)) : path;
}

export function writeAtomic(dest: string, content: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, dest);
}

export class ForgeStore {
  readonly root: string;
  readonly ledgerPath: string;

  constructor(dataPath: string | undefined) {
    this.root = dataPath ? expandHome(dataPath) : join(homedir(), '.dsh', 'task-forge');
    this.ledgerPath = join(this.root, 'ledger.jsonl');
  }

  taskPath(id: string): string {
    return join(this.root, 'tasks', id, 'task.md');
  }

  outboxPath(name: string): string {
    return join(this.root, 'outbox', name);
  }

  loadTask(id: string): TaskBook | null {
    const path = this.taskPath(id);
    if (!existsSync(path)) return null;
    const { task, issues } = parseTaskMarkdown(readFileSync(path, 'utf8'));
    if (!task) throw new Error(`任务书 ${id} 损坏无法解析：${issues.join('；')}`);
    return task;
  }

  saveTask(task: TaskBook): void {
    writeAtomic(this.taskPath(task.id), renderTaskMarkdown(task));
  }

  loadStates() {
    if (!existsSync(this.ledgerPath)) return { events: [], skipped: 0 };
    return parseLedger(readFileSync(this.ledgerPath, 'utf8'));
  }

  /** Light inventory for fuzzy matching: id + title from every task book. */
  listTasks(): Array<{ id: string; title: string }> {
    const dir = join(this.root, 'tasks');
    if (!existsSync(dir)) return [];
    const out: Array<{ id: string; title: string }> = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = join(dir, entry.name, 'task.md');
      if (!existsSync(file)) continue;
      try {
        const head = readFileSync(file, 'utf8').slice(0, 400);
        const id = /\bid: (\S+)/.exec(head)?.[1];
        const title = /\btitle: (.+)/.exec(head)?.[1] ?? '';
        if (id) out.push({ id, title });
      } catch {
        // unreadable book: skip — exact-id lookup may still work
      }
    }
    return out;
  }

  appendEvent(event: Parameters<typeof eventLine>[0]): void {
    mkdirSync(dirname(this.ledgerPath), { recursive: true });
    appendFileSync(this.ledgerPath, eventLine(event) + '\n', 'utf8');
  }
}

// parseTaskMarkdown lives in the pure layer; parse errors on load must name the task.

/** Gap numbers are never reused: answering Q1 shortens OPEN, so a count-based next
 * number would hand "Q1" to a brand-new question — and an answered Q1 still shows up
 * as `D#（原 Q1 已答）`, which the receiver cites. Number past both. */
function nextGapQids(task: TaskBook, count: number): string[] {
  const numbers = [
    ...remainingGapIds(task.open).map((qid) => Number.parseInt(qid.slice(1), 10)),
    ...[...task.decisions.matchAll(/原\s*Q(\d+)/g)].map((match) => Number.parseInt(match[1]!, 10)),
  ];
  const highest = numbers.length ? Math.max(...numbers) : 0;
  return Array.from({ length: count }, (_, index) => `Q${highest + index + 1}`);
}

export function apply(ctx: Context, config: Config): void {
  const log = ctx.logger('task-forge');
  if (!config.enabled) return void log.info('disabled by config');
  // Startup probe contract: a bad value must fail startup naming this plugin,
  // never limp along with a silently useless ledger.
  if (!Number.isInteger(config.limit) || config.limit < 1) throw new TypeError('task-forge: limit must be a positive integer');
  if (!Number.isInteger(config.maxChars) || config.maxChars < 40) throw new TypeError('task-forge: maxChars must be >= 40');
  if (!Number.isFinite(config.order)) throw new TypeError('task-forge: order must be a finite number');
  if (typeof config.hubPath !== 'string' || !config.hubPath.trim() || config.hubPath.includes('\n')) {
    throw new TypeError('task-forge: hubPath must be a single-line relative directory');
  }
  if (typeof config.quotaSummaryPath !== 'string' || !config.quotaSummaryPath.trim() || config.quotaSummaryPath.includes('\n')) {
    throw new TypeError('task-forge: quotaSummaryPath must be a single-line file path');
  }
  if (typeof config.quotaHistoryPath !== 'string' || !config.quotaHistoryPath.trim() || config.quotaHistoryPath.includes('\n')) {
    throw new TypeError('task-forge: quotaHistoryPath must be a single-line file path');
  }

  const store = new ForgeStore(config.dataPath);

  const taskById = (raw: string): { id: string; tokenLen: number } | { error: string } => {
    // Accepts an exact id, an id prefix, or a unique title substring — users
    // should never have to memorize ids. tokenLen lets callers strip the
    // matched token from the raw input.
    const token = raw.trim().replace(/^#/, '').split(/\s+/)[0] ?? '';
    if (!token) return { error: token };
    if (existsSync(store.taskPath(token))) return { id: token, tokenLen: token.length };
    const tasks = store.listTasks();
    const byPrefix = tasks.filter((task) => task.id.startsWith(token));
    if (byPrefix.length === 1) return { id: byPrefix[0]!.id, tokenLen: token.length };
    const needle = token.toLowerCase();
    const byTitle = tasks.filter((task) => task.title.toLowerCase().includes(needle) && needle.length >= 2);
    if (byTitle.length === 1) return { id: byTitle[0]!.id, tokenLen: token.length };
    if (byPrefix.length > 1 || byTitle.length > 1) return { error: `${token}（匹配到多个任务，说得更具体一点）` };
    return { error: token };
  };

  /** quota publishes its meter; a missing or unreadable file simply means no warning. */
  const quotaSummary = () => {
    const path = expandHome(config.quotaSummaryPath);
    if (!existsSync(path)) return null;
    try {
      return parseQuotaSummary(readFileSync(path, 'utf8'));
    } catch {
      return null;
    }
  };

  /** quota's per-step history grounds the cost estimate; unusable history just means
   * the estimate falls back to the char-count heuristic. */
  const quotaHistory = (): StepUsage[] => {
    const path = expandHome(config.quotaHistoryPath);
    if (!existsSync(path)) return [];
    try {
      return parseHistory(readFileSync(path, 'utf8'));
    } catch {
      return [];
    }
  };

  /** blended price comes from quota's own meter; without a currency or a real
   * cost-per-token there is no honest money figure, so we render tokens only. */
  const costPrice = (summary: ReturnType<typeof quotaSummary>): PriceInput | null => {
    if (!summary || !summary.currency || summary.todayTokens <= 0 || summary.todayCostMicros <= 0) return null;
    return { currency: summary.currency, microsPerToken: summary.todayCostMicros / summary.todayTokens };
  };

  /** Compile instructions ride followup when a live session exists; headless
   * falls back to a paste-me block so the flow never dead-ends. followup has
   * thrown in live web runs — any failure here falls back to the paste block
   * AND the section's compile-pending list, never a swallowed exception. */
  const injectCompile = (task: TaskBook, rawNeed: string): string => {
    const instruction = renderCompileInstruction(task, rawNeed);
    try {
      const session = ctx.agents?.get?.(brandString<never>('client-session' as never)) ?? undefined;
      const agent = (ctx.agents?.list?.() ?? [])[0] ?? session;
      if (agent?.followup) {
        agent.followup(
          createUserMessage({
            content: [{ type: 'text', text: instruction }],
            // format v4 retired the catch-all 'plugin' kind; third-party producers
            // namespace theirs as `plugin:<name>`, which is what the official v3->v4
            // producerKind() migrates legacy wrappers to. A bare `task-forge` would
            // load fine but sits in the namespace v4 reserves for first-party
            // producers (runtime-context, compact-checkpoint, agent-instructions).
            source: { kind: `plugin:${name}`, form: 'notice', summary: `任务编译 ${task.id}` } as unknown as Parameters<typeof createUserMessage>[0]['source'],
          }),
        );
        return `已把编译指令注入当前会话，模型编译后会经 forge_write 落盘。任务 id: ${task.id}（/relay ${task.id} 导出交接包）。`;
      }
    } catch (error) {
      log.warn(`followup injection failed, falling back to paste-me: ${String(error)}`);
    }
    return [
      `任务草稿已建：${task.id}。模型会通过系统提示里的「待编译任务」自动编译（下一两个回合）；若没动静，说"编译任务"或把下面整段手动粘贴到任意 dsh 窗口：`,
      '------------------------ 8< ------------------------',
      instruction,
      '------------------------ >8 ------------------------',
    ].join('\n');
  };

  // Compile-pending tasks ride the system-prompt section — followup() proved
  // unreliable in live web runs (three drafts created, zero compiles), while
  // section injection is the family's live-verified channel.
  const compilePending = (): string => {
    const { events } = store.loadStates();
    const compiled = new Set(events.filter((event) => event.event === 'revised').map((event) => event.task));
    const pending = events
      .filter((event) => event.event === 'created' && !compiled.has(event.task))
      .map((event) => event.task);
    const blocks: string[] = [];
    for (const id of pending.slice(0, 3)) {
      const task = store.loadTask(id);
      if (!task || task.status !== 'draft' || task.acceptance.trim()) continue; // only drafts pending compile
      blocks.push(
        [
          `### 待编译任务 ${id}（${task.mode === 'interview' ? 'interview' : 'auto'} 模式）`,
          `原始需求：${task.goal.slice(0, 300)}`,
          '请立即调用 forge_write 编译这个任务（task_id 用上面的 id），不要先询问用户：能定的写进 decisions，定不了的写成 open 缺口，acceptance 必须逐条编号 A1/A2…。编译完成后告诉用户 /relay 导出。',
        ].join('\n'),
      );
    }
    if (!blocks.length) return '';
    return ['## 待编译任务（task-forge）', '以下任务草稿还没有编译。逐个立即处理，全部完成后再继续回答用户的其他问题：', '', ...blocks].join('\n');
  };

  ctx.systemPrompt.section({
    name: 'task-forge',
    order: config.order,
    text: () => {
      try {
        const parts = [compilePending(), renderSection(foldStates(store.loadStates().events), { limit: config.limit, maxChars: config.maxChars })].filter(Boolean);
        return parts.join('\n\n');
      } catch (error) {
        log.warn(`task-forge section skipped: ${String(error)}`);
        return '';
      }
    },
  });

  ctx.commands.register({
    name: 'forge',
    description: '把大白话需求编译成任务书：/forge <需求> [--mode interview]（默认 auto：模型推演+暴露缺口）',
    input: { hint: '<需求> [--mode interview]' },
    handler: ({ rawInput }) => {
      const raw = String(rawInput ?? '');
      const modeMatch = /\s--mode\s+(auto|interview)\b/.exec(raw);
      const mode: ForgeMode = (modeMatch?.[1] as ForgeMode) ?? 'auto';
      const need = raw.replace(/\s--mode\s+(auto|interview)\b/g, '').trim();
      if (!need) return { kind: 'error', text: '用法：/forge <大白话需求> [--mode interview]。需求说清楚一点，编译质量取决于你给的原始信息。' };
      const now = new Date();
      const task: TaskBook = {
        v: 1,
        id: makeTaskId(now),
        version: 1,
        status: 'draft',
        title: deriveTitle(need),
        mode,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        targets: [],
        goal: need,
        context: '',
        constraints: '',
        acceptance: '',
        decisions: '',
        open: '',
      };
      store.saveTask(task);
      store.appendEvent({ ts: now.toISOString(), task: task.id, event: 'created', version: 1, status: 'draft', title: task.title, note: `mode:${mode}` });
      return { kind: 'success', text: injectCompile(task, need) };
    },
  });

  ctx.commands.register({
    name: 'relay',
    description: '导出任务书交接包（自包含单文件，含握手指令）：/relay <id> [--to <窗口名>|ide:<工具名>]',
    input: { hint: '<id> [--to <窗口名>|ide:zcode]' },
    handler: ({ rawInput }) => {
      const raw = String(rawInput ?? '');
      const found = taskById(raw);
      if ('error' in found) return { kind: 'error', text: `没有任务书 ${found.error || '(空)'}。/forge-list 先看台账。` };
      const toMatch = /\s--to\s+(\S+)/.exec(raw);
      const requested = toMatch ? parseIdeTarget(toMatch[1]) : null;
      const ide = requested === null ? null : ideTargetFor(requested);
      if (requested !== null && ide === null) {
        return { kind: 'error', text: `不认识 ide:${requested}。可派发：${IDE_TARGETS.map((target) => `ide:${target.tool}`).join(' / ')}。不带 ide: 前缀就按普通窗口名处理（把文件贴给那个窗口）。` };
      }
      const target = requested !== null ? `ide:${requested}` : (toMatch?.[1] ?? '未命名窗口');
      const task = store.loadTask(found.id)!;
      const now = new Date().toISOString();
      task.targets = withTarget(task.targets, target);
      task.status = 'relayed';
      task.updatedAt = now;
      store.saveTask(task);
      store.appendEvent({ ts: now, task: task.id, event: 'relayed', version: task.version, status: task.status, title: task.title, target });
      const dest = store.outboxPath(outboxName(task));
      const markdown = renderTaskMarkdown(task);
      writeAtomic(dest, markdown);
      const lines = [`交接包已导出：${dest}`];
      if (ide) {
        const ref = resolve(hubReferencePath(task, config.hubPath));
        writeAtomic(ref, markdown);
        lines.push(renderIdeRelayNote(ide, ref));
      } else {
        lines.push(`把该文件全文粘贴给「${target}」窗口的 AI。对方必须按文内握手指令先回读（复述+缺口+STATUS），STATUS: READY 之前不会开工。`);
      }
      lines.push(`收到回读后：/ack ${task.id}${toMatch ? ` --to ${target}` : ''} <粘贴回读内容>`);
      const summary = quotaSummary();
      lines.push(renderCostLine(estimateTaskCost({ text: markdown, windows: task.targets.length, steps: quotaHistory() }), costPrice(summary)));
      const warning = budgetWarningLine(summary);
      if (warning) lines.push(warning);
      return { kind: 'success', text: lines.join('\n') };
    },
  });

  ctx.commands.register({
    name: 'ack',
    description: '登记接收方的回读：/ack <id> [--to <窗口名>] <回读全文>（READY 放行 / NEED-INPUT 落成缺口）',
    input: { hint: '<id> [--to <窗口名>] <回读全文>' },
    handler: ({ rawInput }) => {
      const input = String(rawInput ?? '').trim();
      const found = taskById(input);
      if ('error' in found) return { kind: 'error', text: `用法：/ack <id> [--to <窗口名>] <回读全文>。没有任务书 ${found.error || '(空)'}。` };
      const task = store.loadTask(found.id)!;
      const toMatch = /\s--to\s+(\S+)/.exec(input);
      // One holder needs no flag; several windows must say which one read back,
      // otherwise the per-window ledger would credit the wrong window.
      const target = toMatch?.[1] ?? (task.targets.length === 1 ? task.targets[0]!.name : null);
      const content = input.trim().slice(found.tokenLen).replace(/\s--to\s+\S+/, '').trim();
      const hs = parseHandshake(content);
      if (!hs.ok) return { kind: 'error', text: renderAckReply(hs, task, target ?? '对方') };
      const now = new Date().toISOString();
      const wantsInput = needsSenderInput(hs);
      const passing = !wantsInput && !isStaleVersion(hs, task.version);
      if (target && !wantsInput) task.targets = withTargetAcked(task.targets, target, hs.version!, now);
      const qids = wantsInput ? nextGapQids(task, hs.gaps.length) : [];
      if (qids.length) task.open = [task.open.trim(), ...hs.gaps.map((gap, index) => `${qids[index]} (来自对方回读): ${gap}`)].filter(Boolean).join('\n');
      if (passing) task.status = 'ready';
      task.updatedAt = now;
      store.saveTask(task);
      store.appendEvent({
        ts: now,
        task: task.id,
        event: 'acked',
        version: passing ? task.version : (hs.version ?? task.version),
        status: passing ? 'ready' : task.status,
        title: task.title,
        target: target ?? (passing ? '握手通过' : undefined),
        note: passing
          ? undefined
          : wantsInput
            ? `${hs.status === 'ready' ? 'READY 但列了缺口' : 'need-input'} · 缺口 ${hs.gaps.length} 条`
            : `stale v${hs.version}`,
      });
      const who = target ?? '对方';
      const unnamed = target === null && task.targets.length > 1 ? `（有 ${task.targets.length} 个窗口，下次加 --to <窗口名> 才记得住是谁回读的）` : '';
      return { kind: 'success', text: renderAckReply(hs, task, who, qids) + unnamed };
    },
  });

  ctx.commands.register({
    name: 'answer',
    description: '回答任务书的开放缺口（版本 +1）：/answer <id> <Q编号> <答案>',
    input: { hint: '<id> <Q编号> <答案>' },
    handler: ({ rawInput }) => {
      const input = String(rawInput ?? '').trim();
      const found = taskById(input);
      if ('error' in found) return { kind: 'error', text: `用法：/answer <id> <Q编号> <答案>。没有任务书 ${found.error || '(空)'}。` };
      const task = store.loadTask(found.id)!;
      const rest = input.trim().slice(found.tokenLen).trim();
      const [qid, ...answerParts] = rest.split(/\s+/);
      const answer = answerParts.join(' ').trim();
      if (!qid || !answer) return { kind: 'error', text: `用法：/answer ${task.id} <Q编号> <答案>。缺口编号见 /forge-list 或上次 /ack 输出。` };
      const result = applyAnswer(task, qid, answer);
      if (result.kind === 'missing') return { kind: 'error', text: `${task.id} 的开放缺口里没有 ${qid}。当前缺口：\n${task.open || '（无）'}` };
      store.saveTask(result.task);
      store.appendEvent({
        ts: new Date().toISOString(),
        task: result.task.id,
        event: 'gap-resolved',
        version: result.task.version,
        status: result.task.status,
        title: result.task.title,
        note: `${result.qid} → ${result.decisionId}`,
      });
      const targets = targetNames(result.task.targets).join(' 和 ') || '还没有窗口交接过';
      const base = `${result.qid} 已答并写入 ${result.decisionId}，任务书现在是 ${result.task.id}@v${result.task.version}。已交接窗口：${targets}——需要把新版重新 /relay 给它们，让对方按新版重新回读。`;
      const remaining = remainingGapIds(result.task.open);
      if (result.task.phase !== 'awaiting-answers') return { kind: 'success', text: base };
      if (remaining.length) {
        return { kind: 'success', text: `${base}\ninterview 还剩 ${remaining.join(' ')} 没答；答完最后一条就会自动开始编译。` };
      }
      // Last answer of the interview: hand the book back to the compiler, then clear the
      // phase so a repeated /answer on the same version cannot fire the loop twice.
      const compiled = injectCompile(result.task, result.task.goal);
      store.saveTask(withPhase(result.task));
      store.appendEvent({
        ts: new Date().toISOString(),
        task: result.task.id,
        event: 'revised',
        version: result.task.version,
        status: result.task.status,
        title: result.task.title,
        note: 'interview 答完 → 重新编译',
      });
      return { kind: 'success', text: `${base}\ninterview 的问题已全部答完。${compiled}` };
    },
  });

  ctx.commands.register({
    name: 'forge-list',
    description: '任务台账总览：状态/握手进度/缺口与决策计数/下一步动作',
    handler: () => {
      const { events, skipped } = store.loadStates();
      const states = foldStates(events);
      const details = new Map<string, TaskDetail>();
      const summary = quotaSummary();
      const price = costPrice(summary);
      const steps = quotaHistory();
      for (const state of states) {
        try {
          const task = store.loadTask(state.id);
          if (!task) continue;
          details.set(state.id, {
            mode: task.mode,
            gaps: remainingGapIds(task.open).length,
            decisions: task.decisions.split(/\r?\n/).filter((line) => /^\s*D\d+(?=$|[\s:：.)、])/.test(line)).length,
            targets: task.targets,
            cost: renderCostCompact(estimateTaskCost({ text: renderTaskMarkdown(task), windows: task.targets.length, steps })),
          });
        } catch {
          details.set(state.id, { gaps: 0, decisions: 0, missing: true });
        }
      }
      return { kind: 'success', text: renderForgeList(states, skipped, details) };
    },
  });

  ctx.commands.register({
    name: 'forge-done',
    description: '标记任务完成：/forge-done <id>',
    input: { hint: '<id>' },
    handler: ({ rawInput }) => {
      const found = taskById(String(rawInput ?? ''));
      if ('error' in found) return { kind: 'error', text: `没有任务书 ${found.error || '(空)'}。/forge-list 先看台账。` };
      const task = store.loadTask(found.id)!;
      const now = new Date().toISOString();
      task.status = 'done';
      task.updatedAt = now;
      store.saveTask(task);
      store.appendEvent({ ts: now, task: task.id, event: 'done', version: task.version, status: 'done', title: task.title });
      return { kind: 'success', text: `${task.id} 已标记完成，不再注入系统提示。` };
    },
  });

  ctx.commands.register({
    name: 'forge-show',
    description: '查看任务书全文：/forge-show <模糊id>（顶部一行状态摘要，后接完整任务书）',
    input: { hint: '<id|前缀|标题子串>' },
    handler: ({ rawInput }) => {
      try {
        const found = taskById(String(rawInput ?? ''));
        if ('error' in found) return { kind: 'error', text: `没有任务书 ${found.error || '(空)'}。/forge-list 先看台账。` };
        const task = store.loadTask(found.id)!;
        const summary = `任务书 ${task.id}@v${task.version} [${STATUS_LABEL[task.status]}] · 窗口: ${targetSummary(task.targets, task.version)}`;
        return { kind: 'success', text: `${summary}\n\n${renderTaskMarkdown(task)}` };
      } catch (error) {
        return { kind: 'error', text: `/forge-show 内部出错：${String(error)}` };
      }
    },
  });

  ctx.commands.register({
    name: 'forge-note',
    description: '向任务书 CONTEXT 追加备注行（不 bump version，备注非协议变更）：/forge-note <模糊id> <文本>',
    input: { hint: '<id|前缀|标题子串> <备注>' },
    handler: ({ rawInput }) => {
      try {
        const input = String(rawInput ?? '');
        const found = taskById(input);
        if ('error' in found) return { kind: 'error', text: `没有任务书 ${found.error || '(空)'}。/forge-list 先看台账。` };
        const text = input.trim().slice(found.tokenLen).trim();
        if (!text) return { kind: 'error', text: `用法：/forge-note <模糊id> <备注文本>。备注以日期行追加到 CONTEXT，版本不变。` };
        const now = new Date();
        const task = store.loadTask(found.id)!;
        const next = withNote(task, text, now);
        store.saveTask(next);
        store.appendEvent({ ts: now.toISOString(), task: next.id, event: 'noted', version: next.version, status: next.status, title: next.title, note: text });
        return { kind: 'success', text: `备注已追加到 ${next.id} 的 CONTEXT（版本保持 v${next.version}，已交接窗口无需重读）。` };
      } catch (error) {
        return { kind: 'error', text: `/forge-note 内部出错：${String(error)}` };
      }
    },
  });

  ctx.tools.register(
    defineTool({
      name: 'forge_write',
      description:
        '把编译好的任务书字段落盘（只在用户 /forge 编译流程中使用，task id 用编译指令里给的）。interview 模式第一轮只传 questions。',
      parameters: {
        task_id: { type: 'string', required: true, description: '任务 id，如 20261001-a3f2' },
        title: { type: 'string', description: '任务标题（一句话）' },
        goal: { type: 'string', description: '目标：要做成什么' },
        context: { type: 'string', description: '背景：项目现状、已有资产、术语表' },
        constraints: { type: 'string', description: '约束：技术栈/预算/不许做的事' },
        acceptance: { type: 'string', description: '验收标准，逐条编号 A1/A2…' },
        decisions: { type: 'string', description: '已定决策，逐条编号 D1/D2…并写明理由' },
        open: { type: 'string', description: '开放缺口，逐条编号 Q1/Q2…' },
        questions: { type: 'string', description: 'interview 模式：先问用户的问题清单' },
      },
      output: {
        schema: { type: 'string' } as const,
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      presentCall: (args) => {
        const id = String(args.task_id ?? '').trim();
        const asking = String(args.questions ?? '').trim() && !String(args.goal ?? '').trim();
        return {
          card: 'generic' as const,
          title: asking ? `登记 interview 问题清单 · ${id}` : `写入任务书 ${id}`,
          kind: 'edit' as const,
          rawInput: asking ? String(args.questions) : String(args.goal ?? ''),
          locations: [{ path: store.taskPath(id) }],
        };
      },
      presentResult: (_args, result) => ({
        card: 'generic' as const,
        title: forgeCardTitle(String(result)),
        content: [{ type: 'text' as const, text: String(result) }],
      }),
      async execute(args) {
        const id = String(args.task_id ?? '').trim();
        const task = store.loadTask(id);
        if (!task) return `找不到任务 ${id}。先用 /forge 建草稿，再按编译指令里的 id 调本工具。`;
        const now = new Date().toISOString();
        const questions = typeof args.questions === 'string' ? args.questions.trim() : '';
        const isInterviewRound = questions.length > 0 && !String(args.goal ?? '').trim();
        const writtenDecisions = String(args.decisions ?? task.decisions) || task.decisions;
        const preserved = isInterviewRound ? { decisions: writtenDecisions, restored: [] as string[] } : preservedAnswers(task.decisions, writtenDecisions);
        const merged: TaskBook = {
          ...task,
          title: String(args.title ?? task.title).trim() || task.title,
          goal: String(args.goal ?? task.goal) || task.goal,
          context: String(args.context ?? task.context) || task.context,
          constraints: String(args.constraints ?? task.constraints) || task.constraints,
          acceptance: String(args.acceptance ?? task.acceptance) || task.acceptance,
          decisions: preserved.decisions,
          open: (isInterviewRound ? questions : String(args.open ?? task.open)) || task.open,
          updatedAt: now,
        };
        const next = isInterviewRound ? withPhase(merged, 'awaiting-answers') : merged;
        const issues = validateTask(next);
        if (issues.length && !isInterviewRound) return `字段没过校验，未落盘：\n- ${issues.join('\n- ')}\n修好后重新调用。`;
        store.saveTask(next);
        store.appendEvent({
          ts: now,
          task: next.id,
          event: 'revised',
          version: next.version,
          status: next.status,
          title: next.title,
          note: isInterviewRound ? 'interview 问题清单' : 'compiled',
        });
        const restored = preserved.restored.length ? `\n（编译时漏掉的 ${preserved.restored.length} 条用户答复已原样补回 DECISIONS）` : '';
        return isInterviewRound
          ? `任务 ${next.id} 的问题清单已记录（${remainingGapIds(next.open).length} 问）。把它们原样转给用户，并告诉他：用 /answer ${next.id} Q1 <答案> 逐条直答，答完最后一个 Q 会自动重新注入编译指令。`
          : `任务书 ${next.id}@v${next.version} 已落盘。告诉用户：/relay ${next.id} [--to <窗口名>|ide:<工具名>] 导出交接包。${restored}`;
      },
    }),
  );

  log.info(`mounted · ${store.root} · limit=${config.limit} maxChars=${config.maxChars} order=${config.order}`);
}
