/** Pure handshake ledger: one JSONL event per protocol step, folded into
 * per-task state. The ledger is the single authority for "who holds which
 * version of which task" — the system-prompt section reads it live, so a
 * relay or ack lands in every future session without restarts. */

export type LedgerEventKind = 'created' | 'revised' | 'relayed' | 'acked' | 'gap-resolved' | 'done';

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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const KINDS: readonly string[] = ['created', 'revised', 'relayed', 'acked', 'gap-resolved', 'done'];

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
  const clean = { ...event, note: event.note?.replace(/\s+/g, ' ').trim() };
  return JSON.stringify(clean);
}

/** Later events win; targets accumulate across relay/ack; title sticks from
 * whichever event last carried one. Fold order = file order. */
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
    };
    current.events += 1;
    current.lastAt = event.ts;
    if (typeof event.version === 'number') current.version = event.version;
    if (event.status) current.status = event.status;
    if (event.title) current.title = event.title;
    if (event.target && (event.event === 'relayed' || event.event === 'acked') && !current.targets.includes(event.target)) {
      current.targets.push(event.target);
    }
    states.set(event.task, current);
  }
  return [...states.values()].sort((a, b) => (a.lastAt === b.lastAt ? (a.id < b.id ? 1 : -1) : a.lastAt < b.lastAt ? 1 : -1));
}

export function renderForgeList(states: TaskState[], skipped = 0): string {
  if (!states.length) return '任务台账是空的。/forge <大白话需求> 编译第一个任务书。';
  const lines = states.map((state) => {
    const targets = state.targets.length ? ` → 已交接: ${state.targets.join(', ')}` : '';
    return `  ${state.id}@v${state.version} [${state.status}] ${state.title || '（未命名）'}${targets}`;
  });
  const summary = `任务台账 ${states.length} 个 · 最近活动 ${states[0]!.lastAt.slice(0, 16).replace('T', ' ')}`;
  const hint = skipped ? `\n⚠ ${skipped} 行台账损坏被跳过` : '';
  return [summary, ...lines].join('\n') + hint;
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
