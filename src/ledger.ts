/** Pure handshake ledger: one JSONL event per protocol step, folded into
 * per-task state. The ledger is the single authority for "who holds which
 * version of which task" — the system-prompt section reads it live, so a
 * relay or ack lands in every future session without restarts. */

import { STATUS_LABEL, targetSummary, type TaskStatus, type TaskTarget } from './taskbook.ts';

export type LedgerEventKind = 'created' | 'revised' | 'relayed' | 'acked' | 'gap-resolved' | 'noted' | 'done';

export interface LedgerEvent {
  ts: string;
  task: string;
  event: LedgerEventKind;
  version?: number;
  status?: string;
  title?: string;
  target?: string;
  note?: string;
}

export interface TaskState {
  id: string;
  title: string;
  version: number;
  status: string;
  targets: string[];
  lastAt: string;
  events: number;
  /** handshake tallies folded from acked events */
  acksReady: number;
  acksGap: number;
  /** context notes appended via /forge-note — metadata, version untouched */
  notes: number;
  lastNote?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const KINDS: readonly string[] = ['created', 'revised', 'relayed', 'acked', 'gap-resolved', 'noted', 'done'];

export function parseLine(line: string): LedgerEvent | null {
  const text = line.trim();
  if (!text) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (typeof value.task !== 'string' || !value.task) return null;
  if (typeof value.event !== 'string' || !KINDS.includes(value.event)) return null;
  if (typeof value.ts !== 'string' || !Number.isFinite(Date.parse(value.ts))) return null;
  const ev = value as unknown as LedgerEvent;
  if (value.v !== undefined && value.v !== 1) return null; // future envelope
  // Notes come from user/agent free text: a stray newline would break JSONL.
  return { ...ev, note: typeof ev.note === 'string' ? ev.note.replace(/\s+/g, ' ').trim() : undefined };
}

export function parseLedger(content: string): { events: LedgerEvent[]; skipped: number } {
  const events: LedgerEvent[] = [];
  let skipped = 0;
  for (const line of content.split(/\r?\n/)) {
    const event = parseLine(line);
    if (event) events.push(event);
    else if (line.trim()) skipped++;
  }
  return { events, skipped };
}

export function eventLine(event: LedgerEvent): string {
  // envelope version for P5 compatibility: older readers and older cached
  // state meet what we write; parseLine accepts v1 and versionless legacy rows
  const clean = { v: 1, ...event, note: event.note?.replace(/\s+/g, ' ').trim() };
  return JSON.stringify(clean);
}

/** Later events win; targets accumulate across relay/ack; ack tallies fold
 * from event notes; title sticks from whichever event last carried one. */
export function foldStates(events: LedgerEvent[]): TaskState[] {
  const states = new Map<string, TaskState>();
  for (const event of events) {
    const current = states.get(event.task) ?? {
      id: event.task,
      title: '',
      version: 0,
      status: 'draft',
      targets: [],
      lastAt: event.ts,
      events: 0,
      acksReady: 0,
      acksGap: 0,
      notes: 0,
    };
    current.events += 1;
    current.lastAt = event.ts;
    if (typeof event.version === 'number') current.version = event.version;
    if (event.status) current.status = event.status;
    if (event.title) current.title = event.title;
    if (event.note) current.lastNote = event.note;
    if (event.event === 'noted') current.notes += 1;
    if (event.target && (event.event === 'relayed' || event.event === 'acked') && !current.targets.includes(event.target)) {
      current.targets.push(event.target);
    }
    if (event.event === 'acked') {
      if (event.status === 'ready') current.acksReady += 1;
      else if (/need-input|stale/i.test(event.note ?? '')) current.acksGap += 1;
    }
    states.set(event.task, current);
  }
  return [...states.values()].sort((a, b) => (a.lastAt === b.lastAt ? (a.id < b.id ? 1 : -1) : a.lastAt < b.lastAt ? 1 : -1));
}

/** Compact relative time for the ledger view ("刚刚", "3 小时前", "2 天前"). */
export function relativeTime(ts: string, now: Date = new Date()): string {
  const then = Date.parse(ts);
  if (!Number.isFinite(then)) return '时间未知';
  const diff = now.getTime() - then;
  if (diff < 60_000) return '刚刚';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/** The one action that moves this task forward, by protocol position. */
export function nextStepHint(status: string, acksGap: number): string {
  switch (status) {
    case 'draft':
      return '等模型编译（forge_write），或直接 /relay 导出草稿';
    case 'relayed':
      return acksGap > 0
        ? '有回读待补缺口：/answer 逐条回答，答完重新 /relay 新版'
        : '等接收方回读；把回读全文交给 /ack';
    case 'ready':
      return '可以让它开工；引用任务一定带 id@version';
    case 'in-progress':
      return '干完 /forge-done 收档';
    case 'done':
      return '已归档';
    default:
      return '';
  }
}

/** Per-task facts that live in the task book, not the ledger. */
export interface TaskDetail {
  mode?: string;
  gaps: number;
  decisions: number;
  /** who holds the book and what version each of them read back */
  targets?: TaskTarget[];
  /** compact token-cost estimate line, precomputed by the caller */
  cost?: string;
  missing?: boolean;
}

export function renderForgeList(states: TaskState[], skipped = 0, details: Map<string, TaskDetail> = new Map()): string {
  if (!states.length) return '任务台账是空的。/forge <大白话需求> 编译第一个任务书。';
  const summaryParts: string[] = [];
  for (const status of ['draft', 'relayed', 'ready', 'in-progress', 'done'] as const) {
    const n = states.filter((state) => state.status === status).length;
    if (n > 0) summaryParts.push(`${STATUS_LABEL[status]} ${n}`);
  }
  const lines = [`任务台账 ${states.length} 个 · ${summaryParts.join(' · ')}`];
  for (const state of states) {
    const mark = STATUS_MARK[state.status] ?? '○';
    lines.push(`  ${mark} ${state.id}@v${state.version} [${STATUS_LABEL[state.status as TaskStatus] ?? state.status}] ${state.title || '（未命名）'}`);
    const facts: string[] = [relativeTime(state.lastAt)];
    const detail = details.get(state.id);
    if (detail?.mode) facts.push(detail.mode === 'interview' ? 'interview' : 'auto');
    if (state.acksReady) facts.push(`回读通过 ${state.acksReady} 次`);
    if (state.acksGap) facts.push(`待补缺口 ${state.acksGap} 次`);
    if (state.notes) facts.push(`备注 ${state.notes}`);
    if (detail) {
      if (detail.missing) facts.push('⚠ 任务书文件缺失');
      else {
        if (detail.gaps) facts.push(`缺口 ${detail.gaps}`);
        if (detail.decisions) facts.push(`决策 ${detail.decisions}`);
        if (detail.cost) facts.push(detail.cost);
      }
    }
    // Per-window read-back comes from the task book; the ledger only knows names.
    if (detail?.targets?.length) facts.push(`窗口: ${targetSummary(detail.targets, state.version)}`);
    else if (state.targets.length) facts.push(`交接: ${state.targets.join(', ')}`);
    if (state.status === 'draft' && state.lastNote) facts.push(state.lastNote);
    lines.push('      ' + facts.join(' · '));
    const hint = nextStepHint(state.status, state.acksGap);
    if (hint) lines.push(`      ▸ ${hint}`);
  }
  if (skipped) lines.push(`⚠ ${skipped} 行台账损坏被跳过`);
  return lines.join('\n');
}

export interface SectionBudget {
  limit: number;
  maxChars: number;
}

const STATUS_MARK: Record<string, string> = { draft: '○', relayed: '◐', ready: '◉', 'in-progress': '▶', done: '✓' };

/** Injected section: only live (non-done) tasks, capped like pinboard's budget.
 * An oversized line is truncated rather than dropped so the newest task always shows. */
export function renderSection(states: TaskState[], budget: SectionBudget): string {
  const live = states.filter((state) => state.status !== 'done').slice(0, budget.limit);
  if (!live.length) return '';
  const lines: string[] = [];
  let used = 0;
  for (const state of live) {
    const remaining = budget.maxChars - used - (lines.length ? 1 : 0);
    if (remaining < 3) break;
    const mark = STATUS_MARK[state.status] ?? '○';
    const targets = state.targets.length ? `，交接给 ${state.targets.join('/')}` : '';
    const line = `- ${mark} ${state.id}@v${state.version} ${state.title || '（未命名）'} [${state.status}]${targets}`;
    if (line.length <= remaining) {
      lines.push(line);
      used += line.length + (lines.length > 1 ? 1 : 0);
      continue;
    }
    if (!lines.length) lines.push(`${line.slice(0, Math.max(0, remaining - 1))}…`);
    break;
  }
  if (!lines.length) return '';
  return [
    '## 进行中任务（task-forge）',
    '这些任务正通过任务书+回读握手跨窗口交接。引用任务必须带完整版本号（id@version）；收到任务书的 AI 先按握手指令回读，再开工。',
    ...lines,
  ].join('\n');
}
