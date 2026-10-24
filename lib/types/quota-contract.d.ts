/** Reads quota's published budget contract before handing work to another window.
 * summary.json is another plugin's output, so it is read tolerantly: missing,
 * malformed, or stale numbers produce **no warning at all** — a scary line built
 * on yesterday's meter reading is worse than staying quiet.
 */
export interface QuotaSummary {
    updatedAt: string;
    currency: string;
    budgetTokens: number;
    maxSessionTokens: number;
    /** null = quota has no budget configured, so "how hot" has no answer */
    maxSessionRatio: number | null;
    nextTurnEstTokens: number | null;
    todayTokens: number;
    todayCostMicros: number;
    sessions: number;
}
/** quota flushes every few steps; older than this, the reading is not this session's. */
export declare const SUMMARY_MAX_AGE_MS: number;
/** where quota publishes, relative to its default data dir */
export declare const DEFAULT_SUMMARY_PATH = "~/.dsh/quota/summary.json";
export declare const BUDGET_WARN_RATIO = 0.8;
/** Tolerant parse: anything unusable is null, never a throw and never a half-object. */
export declare function parseQuotaSummary(raw: string | null | undefined): QuotaSummary | null;
/** One line to append to a /relay result, or '' when there is nothing honest to say. */
export declare function budgetWarningLine(summary: QuotaSummary | null, now?: Date): string;
//# sourceMappingURL=quota-contract.d.ts.map