/** Pure task-book model: a rough need compiled into an open-source-style spec
 * with numbered decisions (D#) and open gaps (Q#), carried around as one
 * self-contained markdown file whose HANDSHAKE section is the lossless-transfer
 * contract — the receiver must restate and confirm before doing any work. */

export type TaskStatus = 'draft' | 'relayed' | 'ready' | 'in-progress' | 'done';
export type ForgeMode = 'auto' | 'interview';

export interface TaskBook {
  v: 1;
  id: string;
  version: number;
  status: TaskStatus;
  title: string;
  mode: ForgeMode;
  createdAt: string;
  updatedAt: string;
  targets: string[];
  goal: string;
  context: string;
  constraints: string;
  acceptance: string;
  decisions: string;
  open: string;
}

export const STATUSES: readonly TaskStatus[] = ['draft', 'relayed', 'ready', 'in-progress', 'done'];
export const STATUS_LABEL: Record<TaskStatus, string> = {
  draft: '草稿',
  relayed: '待回读',
  ready: '回读通过',
  'in-progress': '进行中',
  done: '已完成',
};

const ID_SUFFIX_RE = /^[a-z0-9]{4,8}$/;

/** `20261001-a3f2` — date part from the clock, random suffix from the caller. */
export function makeTaskId(now: Date, random: () => number = Math.random): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let suffix = '';
  for (let i = 0; i < 4; i++) suffix += alphabet[Math.floor(random() * alphabet.length)];
  return `${y}${m}${d}-${suffix}`;
}

export function isValidTaskId(id: string): boolean {
  return /^\d{8}-[a-z0-9]{4,8}$/.test(id);
}

/** Plain-language titles drift long: cap what the ledger and prompts carry. */
export function deriveTitle(raw: string, max = 40): string {
  const first = raw.trim().split(/\r?\n/)[0] ?? '';
  const clean = first.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

export function validateTask(task: TaskBook): string[] {
  const issues: string[] = [];
  if (!isValidTaskId(task.id)) issues.push(`id 不合法: ${task.id}（应为 YYYYMMDD-后缀）`);
  if (!Number.isInteger(task.version) || task.version < 1) issues.push(`version 必须是 >=1 的整数，现在是 ${task.version}`);
  if (!STATUSES.includes(task.status)) issues.push(`status 不合法: ${String(task.status)}`);
  if (task.mode !== 'auto' && task.mode !== 'interview') issues.push(`mode 不合法: ${String(task.mode)}`);
  if (!task.title.trim()) issues.push('title 不能为空');
  if (!Number.isFinite(Date.parse(task.createdAt))) issues.push(`createdAt 不是日期: ${task.createdAt}`);
  if (!Number.isFinite(Date.parse(task.updatedAt))) issues.push(`updatedAt 不是日期: ${task.updatedAt}`);
  if (!Array.isArray(task.targets) || task.targets.some((t) => typeof t !== 'string' || !t.trim())) issues.push('targets 必须是非空字符串数组');
  if (!task.goal.trim()) issues.push('goal 不能为空');
  if (!task.acceptance.trim()) issues.push('acceptance 不能为空（任务书没有可检验的验收标准就不是任务书）');
  return issues;
}

/** Every revision bumps the version — receivers confirm by number, so a stale
 * restatement of v2 must not pass as an ack of v3. */
export function revise(task: TaskBook, now = new Date()): TaskBook {
  return { ...task, version: task.version + 1, updatedAt: now.toISOString() };
}

function openLines(open: string): string[] {
  return open.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function decisionCount(decisions: string): number {
  return decisions.split(/\r?\n/).filter((line) => /^\s*D\d+(?=$|[\s:：.)、])/.test(line)).length;
}

export function findOpenLine(task: TaskBook, qid: string): string | null {
  const num = Number.parseInt(qid.replace(/\D/g, ''), 10);
  if (!Number.isInteger(num)) return null;
  const found = openLines(task.open).find((line) => {
    const match = /^Q(\d+)(?=$|[\s:：.)、])/.exec(line);
    return match !== null && Number.parseInt(match[1]!, 10) === num;
  });
  return found ?? null;
}

export type AnswerResult =
  | { kind: 'missing'; qid: string }
  | { kind: 'answered'; task: TaskBook; decisionId: string; qid: string };

/** A gap answer becomes a numbered decision and leaves OPEN; version +1. */
export function applyAnswer(task: TaskBook, qid: string, answer: string, now = new Date()): AnswerResult {
  const line = findOpenLine(task, qid);
  if (!line) return { kind: 'missing', qid };
  const num = Number.parseInt(/^Q(\d+)/.exec(line)![1]!, 10);
  const decisionId = `D${decisionCount(task.decisions) + 1}`;
  const kept = openLines(task.open).filter((candidate) => candidate !== line).join('\n');
  const decisions = [task.decisions.trim(), `${decisionId}（原 Q${num} 已答）: ${answer.trim()}`].filter(Boolean).join('\n');
  return {
    kind: 'answered',
    qid: `Q${num}`,
    decisionId,
    task: revise({ ...task, decisions, open: kept }, now),
  };
}

export const HANDSHAKE_TEXT = [
  '接收这份任务书的 AI：开工前必须先回读，输出以下三段，否则不要执行任何操作：',
  '1. 【回读】用你自己的话复述目标、约束、验收标准（逐条对应原文编号）。',
  '2. 【缺口】你发现的信息不足或矛盾之处，逐条编号列出；没有则写"无"。',
  '3. 第一行写 version: <本文件 frontmatter 里的 version>，最后一行写 STATUS: READY 或 STATUS: NEED-INPUT。',
  '发送方会回答缺口并出新版任务书（version+1）；你确认的版本号必须与最新版一致，旧版本回读无效。',
  '在你输出 STATUS: READY 之前，不要创建文件、不要改代码、不要开始执行任务。',
].join('\n');

const SECTIONS: Array<{ key: keyof TaskBook & string; heading: string }> = [
  { key: 'goal', heading: '## 目标（GOAL）' },
  { key: 'context', heading: '## 背景（CONTEXT）' },
  { key: 'constraints', heading: '## 约束（CONSTRAINTS）' },
  { key: 'acceptance', heading: '## 验收标准（ACCEPTANCE）' },
  { key: 'decisions', heading: '## 已定决策（DECISIONS）' },
  { key: 'open', heading: '## 开放缺口（OPEN）' },
];

export function renderTaskMarkdown(task: TaskBook): string {
  const frontmatter = [
    '---',
    `id: ${task.id}`,
    `version: ${task.version}`,
    `status: ${task.status}`,
    `title: ${task.title}`,
    `mode: ${task.mode}`,
    `created: ${task.createdAt}`,
    `updated: ${task.updatedAt}`,
    `targets: [${task.targets.join(', ')}]`,
    '---',
  ].join('\n');
  const body = SECTIONS.map(({ key, heading }) => `${heading}\n${(task[key] as string).trim() || '（无）'}`);
  return [frontmatter, '', `# 任务书 ${task.id} · ${task.title}（v${task.version}）`, '', ...body, '', '## 握手指令（HANDSHAKE）', '', HANDSHAKE_TEXT, ''].join('\n');
}

/** Roundtrip parser — a relayed file pasted back (or edited by hand) must come
 * home as a TaskBook. Tolerant: reports issues instead of throwing. */
export function parseTaskMarkdown(content: string): { task: TaskBook | null; issues: string[] } {
  const issues: string[] = [];
  const closed = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!closed) return { task: null, issues: ['找不到 frontmatter（应以 --- 开头并闭合）'] };
  const meta: Record<string, string> = {};
  for (const line of closed[1]!.split(/\r?\n/)) {
    const match = /^([a-zA-Z]+)\s*:\s*(.*)$/.exec(line.trim());
    if (match) meta[match[1]!] = match[2]!.trim();
    else if (line.trim()) issues.push(`frontmatter 行无法解析: ${line.trim()}`);
  }
  const targets = (() => {
    const raw = meta.targets ?? '';
    const inner = raw.replace(/^\[/, '').replace(/\]$/, '').trim();
    return inner ? inner.split(',').map((t) => t.trim()).filter(Boolean) : [];
  })();

  const sections = new Map<string, string>();
  let current: string | null = null;
  const buffer: string[] = [];
  const flush = () => {
    if (current !== null) sections.set(current, buffer.join('\n').trim());
    buffer.length = 0;
  };
  for (const line of content.slice(closed[0]!.length).split(/\r?\n/)) {
    const heading = /^##\s+/.exec(line);
    if (heading) {
      flush();
      current = line.replace(/^##\s+/, '').trim();
      continue;
    }
    if (current !== null) buffer.push(line);
  }
  flush();
  const pick = (heading: string): string => {
    const hit = [...sections.keys()].find((key) => key.startsWith(heading));
    return hit ? sections.get(hit)! : '';
  };

  const task: TaskBook = {
    v: 1,
    id: meta.id ?? '',
    version: Number.parseInt(meta.version ?? '', 10),
    status: (meta.status ?? '') as TaskStatus,
    title: meta.title ?? '',
    mode: (meta.mode ?? '') as ForgeMode,
    createdAt: meta.created ?? '',
    updatedAt: meta.updated ?? '',
    targets,
    goal: pick('目标'),
    context: pick('背景'),
    constraints: pick('约束'),
    acceptance: pick('验收标准'),
    decisions: pick('已定决策'),
    open: pick('开放缺口'),
  };
  return { task, issues: [...issues, ...validateTask(task)] };
}

/** Outbox filename doubles as the version stamp the receiver sees. */
export function outboxName(task: TaskBook): string {
  return `${task.id}-v${task.version}.md`;
}

/** The prompt injected into the compiler turn. auto asks the model to decide
 * what it can and leave numbered gaps; interview asks for questions first. */
export function renderCompileInstruction(task: TaskBook, rawNeed: string): string {
  const interview = task.mode === 'interview';
  return [
    `【任务编译（task-forge）】任务 id: ${task.id}（当前 v${task.version}）`,
    '把下面的用户原始需求编译成结构化任务书。原始需求可能是大白话，允许信息缺失：',
    '"""',
    rawNeed.trim(),
    '"""',
    '编译要求：',
    '1. 深入推演：暴露隐含假设、歧义和缺失信息，不要替用户拍板关键决策。',
    interview
      ? '2. interview 模式：先不要产出完整任务书，把必须由用户回答的问题整理后调用 forge_write（status 填 questions，问题写进 questions 字段）；用户答复后再编译。'
      : '2. auto 模式：能定的自己定并写进 decisions（D1/D2…编号，写明理由）；定不了的整理成编号缺口 Q1/Q2…填进 open 字段。',
    '3. 目标/约束要具体；验收标准逐条编号（A1/A2…）且可检验。',
    '4. 编译结果调用 forge_write 工具落盘（task id 见第一行）。不要自己创建任务文件。',
  ].join('\n');
}
