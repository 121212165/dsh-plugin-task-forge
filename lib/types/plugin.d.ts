/**
 * dsh wiring for task-forge: compile a rough need into a versioned task book,
 * relay it as a self-contained markdown file, and let the read-back handshake
 * (see taskbook.ts HANDSHAKE_TEXT) make the transfer lossless. The ledger is
 * the authority for who holds which version; the system-prompt section reads
 * it live so new windows know what is in flight.
 */
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { type TaskBook } from './taskbook.ts';
import { eventLine } from './ledger.ts';
export declare const name = "task-forge";
export declare const inject: string[];
export interface Config {
    enabled: boolean;
    dataPath?: string;
    /** where a `--to ide:*` copy lands, relative to the session cwd */
    hubPath: string;
    /** quota's published budget contract, read before handing work to another window */
    quotaSummaryPath: string;
    /** quota's published per-step history, read to ground the task cost estimate */
    quotaHistoryPath: string;
    limit: number;
    maxChars: number;
    order: number;
}
export declare const Config: Schema<Schemastery.ObjectS<{
    enabled: Schema<boolean, boolean>;
    dataPath: Schema<string, string>;
    hubPath: Schema<string, string>;
    quotaSummaryPath: Schema<string, string>;
    quotaHistoryPath: Schema<string, string>;
    limit: Schema<number, number>;
    maxChars: Schema<number, number>;
    order: Schema<number, number>;
}>, Schemastery.ObjectT<{
    enabled: Schema<boolean, boolean>;
    dataPath: Schema<string, string>;
    hubPath: Schema<string, string>;
    quotaSummaryPath: Schema<string, string>;
    quotaHistoryPath: Schema<string, string>;
    limit: Schema<number, number>;
    maxChars: Schema<number, number>;
    order: Schema<number, number>;
}>>;
export declare function expandHome(path: string): string;
export declare function writeAtomic(dest: string, content: string): void;
export declare class ForgeStore {
    readonly root: string;
    readonly ledgerPath: string;
    /** task.md 的读改写必须整段排队执行：单实例内多窗口命令、多 dsh 进程
     * 竞争同一数据目录时，load→改→save 否则会互相覆盖（尤其 targets.push）。
     * 链式 promise 即可——失败必须被 catch 后继续，否则断链会让所有后续
     * 操作永远排队。 */
    private chain;
    queue<T>(fn: () => T): Promise<T>;
    constructor(dataPath: string | undefined);
    taskPath(id: string): string;
    outboxPath(name: string): string;
    loadTask(id: string): TaskBook | null;
    saveTask(task: TaskBook): void;
    loadStates(): {
        events: import("./ledger.ts").LedgerEvent[];
        skipped: number;
    };
    /** Light inventory for fuzzy matching: id + title from every task book. */
    listTasks(): Array<{
        id: string;
        title: string;
    }>;
    appendEvent(event: Parameters<typeof eventLine>[0]): void;
}
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=plugin.d.ts.map