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
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  applyAnswer,
  deriveTitle,
  makeTaskId,
  outboxName,
  parseTaskMarkdown,
  renderCompileInstruction,
  renderTaskMarkdown,
  validateTask,
  type ForgeMode,
  type TaskBook,
} from './taskbook.ts';
import { isStaleVersion, parseHandshake, renderAckReply } from './handshake.ts';
import { eventLine, foldStates, parseLedger, renderForgeList, renderSection } from './ledger.ts';

export const name = 'task-forge';
export const inject = ['commands', 'tools', 'systemPrompt', 'llm', 'agents'];

export interface Config {
  enabled: boolean;
  dataPath?: string;
  limit: number;
  maxChars: number;
  order: number;
}

export const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  dataPath: Schema.string(),
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

  appendEvent(event: Parameters<typeof eventLine>[0]): void {
    mkdirSync(dirname(this.ledgerPath), { recursive: true });
    appendFileSync(this.ledgerPath, eventLine(event) + '\n', 'utf8');
  }
}

// parseTaskMarkdown lives in the pure layer; parse errors on load must name the task.

function nextGapQids(open: string, count: number): string[] {
  const existing = open.split(/\r?\n/).filter((line) => /^\s*Q\d+(?=$|[\s:：.)、])/.test(line)).length;
  return Array.from({ length: count }, (_, index) => `Q${existing + index + 1}`);
}

export function apply(ctx: Context, config: Config): void {
  const log = ctx.logger('task-forge');
  if (!config.enabled) return void log.info('disabled by config');
  // Startup probe contract: a bad value must fail startup naming this plugin,
  // never limp along with a silently useless ledger.
  if (!Number.isInteger(config.limit) || config.limit < 1) throw new TypeError('task-forge: limit must be a positive integer');
  if (!Number.isInteger(config.maxChars) || config.maxChars < 40) throw new TypeError('task-forge: maxChars must be >= 40');
  if (!Number.isFinite(config.order)) throw new TypeError('task-forge: order must be a finite number');

  const store = new ForgeStore(config.dataPath);

  const taskById = (raw: string): { id: string } | { error: string } => {
    const id = raw.trim().replace(/^#/, '').split(/\s+/)[0] ?? '';
    return existsSync(store.taskPath(id)) ? { id } : { error: id };
  };

  /** Compile instructions ride followup when a live session exists; headless
   * falls back to a paste-me block so the flow never dead-ends. */
  const injectCompile = (task: TaskBook, rawNeed: string): string => {
    const instruction = renderCompileInstruction(task, rawNeed);
    const session = ctx.agents?.get?.(brandString<never>('client-session' as never)) ?? undefined;
    const agent = (ctx.agents?.list?.() ?? [])[0] ?? session;
    if (agent?.followup) {
      agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: instruction }],
          // format v4: producer-owned kind (the old catch-all 'plugin' is gone)
          source: { kind: name, form: 'notice', summary: `任务编译 ${task.id}` } as unknown as Parameters<typeof createUserMessage>[0]['source'],
        }),
      );
      return `已把编译指令注入当前会话，模型编译后会经 forge_write 落盘。任务 id: ${task.id}（/relay ${task.id} 导出交接包）。`;
    }
    return [
      `任务草稿已建：${task.id}。当前环境没有可注入的活跃会话——把下面整段手动粘贴到任意 dsh 窗口（需已挂载本插件）：`,
      '------------------------ 8< ------------------------',
      renderCompileInstruction(task, rawNeed),
      '------------------------ >8 ------------------------',
    ].join('\n');
  };

  ctx.systemPrompt.section({
    name: 'task-forge',
    order: config.order,
    text: () => {
      try {
        return renderSection(foldStates(store.loadStates().events), { limit: config.limit, maxChars: config.maxChars });
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
    description: '导出任务书交接包（自包含单文件，含握手指令）：/relay <id> [--to <窗口名>]',
    input: { hint: '<id> [--to <窗口名>]' },
    handler: ({ rawInput }) => {
      const found = taskById(String(rawInput ?? ''));
      if ('error' in found) return { kind: 'error', text: `没有任务书 ${found.error || '(空)'}。/forge-list 先看台账。` };
      const task = store.loadTask(found.id)!;
      const toMatch = /\s--to\s+(\S+)/.exec(String(rawInput ?? ''));
      const target = toMatch?.[1] ?? '未命名窗口';
      const now = new Date().toISOString();
      if (!task.targets.includes(target)) task.targets.push(target);
      task.status = 'relayed';
      task.updatedAt = now;
      store.saveTask(task);
      store.appendEvent({ ts: now, task: task.id, event: 'relayed', version: task.version, status: task.status, title: task.title, target });
      const dest = store.outboxPath(outboxName(task));
      writeAtomic(dest, renderTaskMarkdown(task));
      return {
        kind: 'success',
        text: [
          `交接包已导出：${dest}`,
          `把该文件全文粘贴给「${target}」窗口的 AI。对方必须按文内握手指令先回读（复述+缺口+STATUS），STATUS: READY 之前不会开工。`,
          `收到回读后：/ack ${task.id} <粘贴回读内容>`,
        ].join('\n'),
      };
    },
  });

  ctx.commands.register({
    name: 'ack',
    description: '登记接收方的回读：/ack <id> <回读全文>（READY 放行 / NEED-INPUT 落成缺口）',
    input: { hint: '<id> <回读全文>' },
    handler: ({ rawInput }) => {
      const input = String(rawInput ?? '').trim();
      const found = taskById(input);
      if ('error' in found) return { kind: 'error', text: `用法：/ack <id> <回读全文>。没有任务书 ${found.error || '(空)'}。` };
      const task = store.loadTask(found.id)!;
      const content = input.slice(input.indexOf(found.id) + found.id.length).trim();
      const hs = parseHandshake(content);
      if (!hs.ok) return { kind: 'error', text: renderAckReply(hs, task, '对方') };
      const now = new Date().toISOString();
      if (hs.status === 'ready' && !isStaleVersion(hs, task.version)) {
        task.status = 'ready';
        task.updatedAt = now;
        store.saveTask(task);
        store.appendEvent({ ts: now, task: task.id, event: 'acked', version: task.version, status: 'ready', title: task.title, target: '握手通过' });
        return { kind: 'success', text: renderAckReply(hs, task, '对方') };
      }
      const qids = hs.status === 'need-input' && hs.gaps.length ? nextGapQids(task.open, hs.gaps.length) : [];
      if (qids.length) {
        task.open = [task.open.trim(), ...hs.gaps.map((gap, index) => `${qids[index]} (来自对方回读): ${gap}`)].filter(Boolean).join('\n');
        task.updatedAt = now;
        store.saveTask(task);
      }
      store.appendEvent({
        ts: now,
        task: task.id,
        event: 'acked',
        version: hs.version ?? task.version,
        status: task.status,
        title: task.title,
        note: hs.status === 'need-input' ? `need-input · 缺口 ${hs.gaps.length} 条` : `stale v${hs.version}`,
      });
      return { kind: 'success', text: renderAckReply(hs, task, '对方', qids) };
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
      const rest = input.slice(input.indexOf(found.id) + found.id.length).trim();
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
      const targets = result.task.targets.length ? result.task.targets.join(' 和 ') : '还没有窗口交接过';
      return {
        kind: 'success',
        text: `${result.qid} 已答并写入 ${result.decisionId}，任务书现在是 ${result.task.id}@v${result.task.version}。已交接窗口：${targets}——需要把新版重新 /relay 给它们，让对方按新版重新回读。`,
      };
    },
  });

  ctx.commands.register({
    name: 'forge-list',
    description: '任务台账总览：任务 × 版本 × 交接窗口 × 状态',
    handler: () => {
      const { events, skipped } = store.loadStates();
      return { kind: 'success', text: renderForgeList(foldStates(events), skipped) };
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
      async execute(args) {
        const id = String(args.task_id ?? '').trim();
        const task = store.loadTask(id);
        if (!task) return `找不到任务 ${id}。先用 /forge 建草稿，再按编译指令里的 id 调本工具。`;
        const now = new Date().toISOString();
        const questions = typeof args.questions === 'string' ? args.questions.trim() : '';
        const isInterviewRound = questions.length > 0 && !String(args.goal ?? '').trim();
        const next: TaskBook = {
          ...task,
          title: String(args.title ?? task.title).trim() || task.title,
          goal: String(args.goal ?? task.goal) || task.goal,
          context: String(args.context ?? task.context) || task.context,
          constraints: String(args.constraints ?? task.constraints) || task.constraints,
          acceptance: String(args.acceptance ?? task.acceptance) || task.acceptance,
          decisions: String(args.decisions ?? task.decisions) || task.decisions,
          open: (isInterviewRound ? questions : String(args.open ?? task.open)) || task.open,
          updatedAt: now,
        };
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
        return isInterviewRound
          ? `任务 ${next.id} 的问题清单已记录。把问题转给用户，等答复后把每个答案连同完整字段一起再调 forge_write。`
          : `任务书 ${next.id}@v${next.version} 已落盘。告诉用户：/relay ${next.id} [--to <窗口名>] 导出交接包。`;
      },
    }),
  );

  log.info(`mounted · ${store.root} · limit=${config.limit} maxChars=${config.maxChars} order=${config.order}`);
}
