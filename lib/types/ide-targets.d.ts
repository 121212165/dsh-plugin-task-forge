/** `--to ide:<tool>` names an editor, not an AI window someone can paste into.
 * task-forge cannot inject into those tools, so v0.2 does the lossless half —
 * drop a copy of the handoff package inside the project — and prints the one
 * manual step per IDE. Real automatic pickup is ide-hub's pointer generator.
 * Tool names mirror dsh-plugin-ide-hub/src/hub/registry.ts defaultRegistry().
 */
export interface IdeTarget {
    tool: string;
    vendor: 'domestic' | 'global';
    /** how the user gets this editor to read the handed-off file, one line per step */
    steps: string[];
}
export declare const IDE_TARGETS: readonly IdeTarget[];
export declare function ideTargetFor(tool: string): IdeTarget | null;
/** `ide:zcode` → 'zcode'; anything else (a window name, empty, a typo) → null so
 * the caller keeps the v0.1 paste-a-package path. */
export declare function parseIdeTarget(raw: string | undefined): string | null;
/** Where the copy lands, relative to the project the IDE opens. */
export declare function hubReferencePath(task: {
    id: string;
    version: number;
}, dir?: string): string;
export declare function renderIdeRelayNote(ide: IdeTarget, refPath: string): string;
//# sourceMappingURL=ide-targets.d.ts.map