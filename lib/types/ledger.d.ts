/** Pure handshake ledger: one JSONL event per protocol step, folded into
 * per-task state. The ledger is the single authority for "who holds which
 * version of which task" — the system-prompt section reads it live, so a
 * relay or ack lands in every future session without restarts. */
import { type TaskBook, type TaskTarget } from './taskbook.ts';
export type LedgerEventKind = 'created' | 'compiled' | 'revised' | 'relayed' | 'acked' | 'gap-resolved' | 'noted' | 'done';
export interface LedgerEvent {
    ts: string;
    task: string;
    event: LedgerEventKind;
    version?: number;
    status?: string;
    title?: string;
    target?: string | undefined;
    note?: string | undefined;
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
export declare function parseLine(line: string): LedgerEvent | null;
export declare function parseLedger(content: string): {
    events: LedgerEvent[];
    skipped: number;
};
export declare function eventLine(event: LedgerEvent): string;
/** Later events win; targets accumulate across relay/ack; ack tallies fold
 * from event notes; title sticks from whichever event last carried one. */
export declare function foldStates(events: LedgerEvent[]): TaskState[];
/** Compact relative time for the ledger view ("刚刚", "3 小时前", "2 天前"). */
export declare function relativeTime(ts: string, now?: Date): string;
/** The one action that moves this task forward, by protocol position. */
export declare function nextStepHint(status: string, acksGap: number): string;
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
export declare function renderForgeList(states: TaskState[], skipped?: number, details?: Map<string, TaskDetail>): string;
export interface SectionBudget {
    limit: number;
    maxChars: number;
}
/** Injected section: only live (non-done) tasks, capped like pinboard's budget.
 * An oversized line is truncated rather than dropped so the newest task always shows. */
export declare function renderSection(states: TaskState[], budget: SectionBudget): string;
/** 台账和 task.md 是两本账：命令侧 bug 或手工编辑都可能让版本漂移。把漂移
 * 变成注入区段里的可见警告，而不是静默矛盾。loader 按 id 读盘（不存在返回
 * null，损坏抛异常——两者都算漂移）。最多报 max 条，避免警告淹没正文。 */
export declare function driftAlerts(states: TaskState[], loader: (id: string) => TaskBook | null, max?: number): string[];
//# sourceMappingURL=ledger.d.ts.map