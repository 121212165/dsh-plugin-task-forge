/** Estimates what a task book will burn once handed to another window, from
 * the book's own text size and, when available, quota's published step history
 * (`~/.dsh/quota/history.json`). Pure: no fs, no host types, no clock — the
 * caller passes the text, the observed steps, and the window count in.
 * @module task-cost */

/** quota publishes history.json next to its summary.json; we read it, never write it */
export const DEFAULT_HISTORY_PATH = '~/.dsh/quota/history.json';

/** tokens ≈ chars / 2.4 for mixed 中文/ASCII text — a measured-ish approximation
 * of what our models actually bill, NOT a real tokenizer. Don't quote it to a vendor. */
export const CHARS_PER_TOKEN = 2.4;

/** a read-back restatement re-emits roughly this fraction of the book's text */
const READBACK_FRACTION = 0.4;
/** the real work spans this many observed steps, low→high (the only range) */
const EXEC_LOW_STEPS = 6;
const EXEC_HIGH_STEPS = 20;
/** with no observations, execution is guessed as this multiple of the book size */
const EXEC_LOW_MULT = 8;
const EXEC_HIGH_MULT = 18;

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

function toTokens(chars: number): number {
  return Math.round(Math.max(0, chars) / CHARS_PER_TOKEN);
}

function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function nonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function readStep(row: unknown): StepUsage | null {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return null;
  const record = row as Record<string, unknown>;
  const input = nonNegative(record.input);
  const output = nonNegative(record.output);
  const cacheRead = nonNegative(record.cacheRead);
  if (input === null || output === null || cacheRead === null) return null;
  return { input, output, cacheRead };
}

/** Tolerant read of quota's history.json: any unusable file or entry collapses to
 * an empty observation list, which flips the caller onto the heuristic path. */
export function parseHistory(raw: string | null | undefined): StepUsage[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  const steps: StepUsage[] = [];
  for (const entry of Object.values(value as Record<string, unknown>)) {
    if (!Array.isArray(entry)) continue;
    for (const row of entry) {
      const step = readStep(row);
      if (step) steps.push(step);
    }
  }
  return steps;
}

/** Deterministic: same text + same observations + same window count → same numbers. */
export function estimateTaskCost(input: EstimateInput): TaskCost {
  const chars = Math.max(0, input.text.length);
  const book = toTokens(chars);
  const windows = Math.max(1, Math.floor(input.windows));
  const steps = input.steps ?? [];
  const observed = steps.length > 0;
  const medOut = observed ? median(steps.map((step) => step.output)) : null;
  const medStep = observed ? median(steps.map((step) => step.input + step.output + step.cacheRead)) : null;

  const compile = book;
  const readback = medOut === null ? toTokens(chars * READBACK_FRACTION) : Math.round(medOut);
  const relayPerWindow = book;
  const relay = relayPerWindow * windows;
  const executeLow = medStep === null ? Math.round(book * EXEC_LOW_MULT) : Math.round(medStep * EXEC_LOW_STEPS);
  const executeHigh = medStep === null ? Math.round(book * EXEC_HIGH_MULT) : Math.round(medStep * EXEC_HIGH_STEPS);

  return {
    observed,
    stepCount: steps.length,
    windows,
    compile,
    readback,
    relayPerWindow,
    relay,
    executeLow,
    executeHigh,
    low: compile + readback + relay + executeLow,
    high: compile + readback + relay + executeHigh,
  };
}

function compactTokens(value: number): string {
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) {
    const k = value / 1000;
    return `${value < 10_000 ? k.toFixed(1).replace(/\.0$/, '') : String(Math.round(k))}k`;
  }
  return `${(value / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
}

function moneySuffix(cost: TaskCost, price?: PriceInput | null): string {
  if (!price || !price.currency || !(price.microsPerToken > 0)) return '';
  const units = (((cost.low + cost.high) / 2) * price.microsPerToken) / 1_000_000;
  return ` · ≈${units.toFixed(units < 0.01 ? 4 : 2)} ${price.currency}`;
}

/** One line for /relay. The base tail tells you whether this is 观测 or 估算. */
export function renderCostLine(cost: TaskCost, price?: PriceInput | null): string {
  const base = cost.observed ? `基于 ${cost.stepCount} 步观测` : '按字数启发式估算（无观测）';
  const phases = `编译 ${compactTokens(cost.compile)} + 回读 ${compactTokens(cost.readback)} + 交接 ${compactTokens(cost.relayPerWindow)}×${cost.windows}窗 + 执行 ${compactTokens(cost.executeLow)}–${compactTokens(cost.executeHigh)}`;
  return `这份任务书预计烧 ${compactTokens(cost.low)}–${compactTokens(cost.high)} tok（${phases}）· ${base}${moneySuffix(cost, price)}`;
}

/** Compact form for a /forge-list line. */
export function renderCostCompact(cost: TaskCost): string {
  return `预估 ${compactTokens(cost.low)}–${compactTokens(cost.high)}`;
}
