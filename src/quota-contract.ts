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
export const SUMMARY_MAX_AGE_MS = 60 * 60_000;
/** where quota publishes, relative to its default data dir */
export const DEFAULT_SUMMARY_PATH = '~/.dsh/quota/summary.json';
export const BUDGET_WARN_RATIO = 0.8;

function wholeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Tolerant parse: anything unusable is null, never a throw and never a half-object. */
export function parseQuotaSummary(raw: string | null | undefined): QuotaSummary | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const updatedAt = typeof row.updatedAt === 'string' && Number.isFinite(Date.parse(row.updatedAt)) ? row.updatedAt : null;
  const budgetTokens = wholeNumber(row.budgetTokens);
  const maxSessionTokens = wholeNumber(row.maxSessionTokens);
  const todayTokens = wholeNumber(row.todayTokens);
  const todayCostMicros = wholeNumber(row.todayCostMicros);
  const sessions = wholeNumber(row.sessions);
  if (updatedAt === null || budgetTokens === null || maxSessionTokens === null || todayTokens === null || todayCostMicros === null || sessions === null) return null;
  const ratio = row.maxSessionRatio === null ? null : wholeNumber(row.maxSessionRatio);
  const nextTurn = row.nextTurnEstTokens === null ? null : wholeNumber(row.nextTurnEstTokens);
  if (row.maxSessionRatio !== null && ratio === null) return null;
  if (row.nextTurnEstTokens !== null && nextTurn === null) return null;
  return {
    updatedAt,
    currency: typeof row.currency === 'string' && row.currency ? row.currency : '',
    budgetTokens,
    maxSessionTokens,
    maxSessionRatio: ratio,
    nextTurnEstTokens: nextTurn,
    todayTokens,
    todayCostMicros,
    sessions,
  };
}

function compactTokens(value: number): string {
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

function money(micros: number, currency: string): string {
  if (micros <= 0 || !currency) return '';
  const value = micros / 1_000_000;
  return ` · 约 ${value.toFixed(value < 0.01 ? 4 : 2)} ${currency}`;
}

/** One line to append to a /relay result, or '' when there is nothing honest to say. */
export function budgetWarningLine(summary: QuotaSummary | null, now = new Date()): string {
  if (!summary) return '';
  if (now.getTime() - Date.parse(summary.updatedAt) > SUMMARY_MAX_AGE_MS) return '';
  if (summary.budgetTokens <= 0 || summary.maxSessionRatio === null) return '';
  const percent = Math.round(summary.maxSessionRatio * 100);
  if (summary.maxSessionRatio < BUDGET_WARN_RATIO) return '';
  const used = `${compactTokens(summary.maxSessionTokens)}/${compactTokens(summary.budgetTokens)}`;
  const next = summary.nextTurnEstTokens === null ? '' : `，下步预估再吃 ~${compactTokens(summary.nextTurnEstTokens)}`;
  const blown = summary.nextTurnEstTokens === null || summary.maxSessionTokens + summary.nextTurnEstTokens > summary.budgetTokens;
  const head = blown ? `⚠ 预算已用 ${percent}%（${used}）${next}——这条交接大概率会烧穿预算` : `△ 预算已用 ${percent}%（${used}）${next}`;
  return `${head}。先 /qm 看清余量、或收尾后 /qm-reset，再决定要不要现在开工${money(summary.todayCostMicros, summary.currency)}。`;
}
