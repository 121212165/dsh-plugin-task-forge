/** Estimates what a task book will burn once handed to another window, from
 * the book's own text size and, when available, quota's published step history
 * (`~/.dsh/quota/history.json`). Pure: no fs, no host types, no clock — the
 * caller passes the text, the observed steps, and the window count in.
 * @module task-cost */
/** quota publishes history.json next to its summary.json; we read it, never write it */
export declare const DEFAULT_HISTORY_PATH = "~/.dsh/quota/history.json";
/** tokens ≈ chars / 2.4 for mixed 中文/ASCII text — a measured-ish approximation
 * of what our models actually bill, NOT a real tokenizer. Don't quote it to a vendor. */
export declare const CHARS_PER_TOKEN = 2.4;
/** quota's history.json shape is mirrored from dsh-plugin-quota, never imported —
 * a field rename there degrades this to "no observations", it does not throw. */
export interface StepUsage {
    input: number;
    output: number;
    cacheRead: number;
}
export interface PriceInput {
    /** ISO-ish currency tag as quota publishes it, e.g. "CNY" */
    currency: string;
    /** blended micro-units per single token; only ever derived from quota's own meter */
    microsPerToken: number;
}
export interface EstimateInput {
    text: string;
    windows: number;
    steps?: readonly StepUsage[];
}
export interface TaskCost {
    observed: boolean;
    stepCount: number;
    windows: number;
    compile: number;
    readback: number;
    relayPerWindow: number;
    relay: number;
    executeLow: number;
    executeHigh: number;
    low: number;
    high: number;
}
/** Tolerant read of quota's history.json: any unusable file or entry collapses to
 * an empty observation list, which flips the caller onto the heuristic path. */
export declare function parseHistory(raw: string | null | undefined): StepUsage[];
/** Deterministic: same text + same observations + same window count → same numbers. */
export declare function estimateTaskCost(input: EstimateInput): TaskCost;
/** One line for /relay. The base tail tells you whether this is 观测 or 估算. */
export declare function renderCostLine(cost: TaskCost, price?: PriceInput | null): string;
/** Compact form for a /forge-list line. */
export declare function renderCostCompact(cost: TaskCost): string;
//# sourceMappingURL=task-cost.d.ts.map