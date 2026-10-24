/** Pure task-book model: a rough need compiled into an open-source-style spec
 * with numbered decisions (D#) and open gaps (Q#), carried around as one
 * self-contained markdown file whose HANDSHAKE section is the lossless-transfer
 * contract — the receiver must restate and confirm before doing any work. */
export type TaskStatus = 'draft' | 'relayed' | 'ready' | 'in-progress' | 'done';
export type ForgeMode = 'auto' | 'interview';
/** An interview book parks here between "questions handed to the user" and
 * "last answer landed" — the phase is what makes /answer know to recompile. */
export type TaskPhase = 'awaiting-answers';
/** A window the book has been relayed to, and what it has confirmed back.
 * `ackedVersion` is the version the handshake restated, so a v1 ack says
 * nothing at all about v2. */
export interface TaskTarget {
    name: string;
    ackedAt?: string;
    ackedVersion?: number;
}
export interface TaskBook {
    v: 1;
    id: string;
    version: number;
    status: TaskStatus;
    title: string;
    mode: ForgeMode;
    phase?: TaskPhase;
    createdAt: string;
    updatedAt: string;
    targets: TaskTarget[];
    goal: string;
    context: string;
    constraints: string;
    acceptance: string;
    decisions: string;
    open: string;
}
export declare const STATUSES: readonly TaskStatus[];
export declare const STATUS_LABEL: Record<TaskStatus, string>;
/** `20261001-a3f2` — date part from the clock, random suffix from the caller. */
export declare function makeTaskId(now: Date, random?: () => number): string;
export declare function isValidTaskId(id: string): boolean;
/** Plain-language titles drift long: cap what the ledger and prompts carry. */
export declare function deriveTitle(raw: string, max?: number): string;
export declare function validateTask(task: TaskBook): string[];
/** Every revision bumps the version — receivers confirm by number, so a stale
 * restatement of v2 must not pass as an ack of v3. */
export declare function revise(task: TaskBook, now?: Date): TaskBook;
/** Setting it to undefined must remove the key, not leave `phase: undefined` behind. */
export declare function withPhase(task: TaskBook, phase?: TaskPhase): TaskBook;
/** A context note is metadata, not protocol: it lands in CONTEXT as a dated
 * line without bumping the version — receivers confirm by version, and a note
 * never touches goal/constraints/acceptance. The version stays, so an existing
 * ✓ ack is not invalidated by it. */
export declare function withNote(task: TaskBook, text: string, now?: Date): TaskBook;
export declare function targetNames(targets: readonly TaskTarget[]): string[];
/** Relaying to a window twice must not fork its ack history. */
export declare function withTarget(targets: readonly TaskTarget[], name: string): TaskTarget[];
/** A handshake that passes stamps the window it came from. Unknown windows get an
 * entry: an ack is evidence that someone holds the book, even if /relay never named them. */
export declare function withTargetAcked(targets: readonly TaskTarget[], name: string, version: number, at: string): TaskTarget[];
/** ✓ = confirmed the current version, ◐ = confirmed an older one, ○ = holds it, hasn't read back. */
export declare function targetMark(target: TaskTarget, currentVersion: number): string;
export declare function targetSummary(targets: readonly TaskTarget[], currentVersion: number): string;
/** The Q# still unanswered — an interview book is done asking when this is empty. */
export declare function remainingGapIds(open: string): string[];
export declare function findOpenLine(task: TaskBook, qid: string): string | null;
export type AnswerResult = {
    kind: 'missing';
    qid: string;
} | {
    kind: 'answered';
    task: TaskBook;
    decisionId: string;
    qid: string;
};
/** A gap answer becomes a numbered decision and leaves OPEN; version +1. */
export declare function applyAnswer(task: TaskBook, qid: string, answer: string, now?: Date): AnswerResult;
/** The compiler must not silently eat the user's answers: every `D#（原 Qn 已答）`
 * line it left out comes back appended, so an interview answer survives a rewrite. */
export declare function preservedAnswers(previous: string, written: string): {
    decisions: string;
    restored: string[];
};
/** One-line card header for a forge_write result, derived from what it actually said. */
export declare function forgeCardTitle(result: string): string;
export declare const HANDSHAKE_TEXT: string;
/** What an empty section prints as, and what must read back as empty again. */
export declare const EMPTY_SECTION = "\uFF08\u65E0\uFF09";
export declare function renderTaskMarkdown(task: TaskBook): string;
/** 正文里用户常见的 `## 小标题` 行会在 parse 时被当成真标题、截断上一段
 * 内容；转义为 `##<零宽空格>` 让它按字面存活，read 侧再还原。字段内容
 * 被转义后视觉上几乎无差，但不再可能丢数据。 */
export declare function escapeSection(text: string): string;
export declare function unescapeSection(text: string): string;
/** Roundtrip parser — a relayed file pasted back (or edited by hand) must come
 * home as a TaskBook. Tolerant: reports issues instead of throwing. */
export declare function parseTaskMarkdown(content: string): {
    task: TaskBook | null;
    issues: string[];
};
/** Outbox filename doubles as the version stamp the receiver sees. */
export declare function outboxName(task: TaskBook): string;
export declare function parseTargets(raw: string): TaskTarget[];
/** The prompt injected into the compiler turn. auto asks the model to decide
 * what it can and leave numbered gaps; interview asks for questions first, and
 * /answer re-injects this same builder once the last gap is answered
 * (phase === 'awaiting-answers'), which is what closes the interview loop. */
export declare function renderCompileInstruction(task: TaskBook, rawNeed: string): string;
//# sourceMappingURL=taskbook.d.ts.map