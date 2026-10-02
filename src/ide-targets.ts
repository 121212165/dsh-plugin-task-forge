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

const READ_BACK = '要求它先按文内「握手指令」回读（复述+缺口+STATUS），回读通过前不要开工';

function cliSteps(launch: string): string[] {
  return [`cd 到项目目录后启动 ${launch}`, `把 .hub/tasks/ 下那份任务书的路径贴给它，${READ_BACK}`];
}

function ideSteps(app: string): string[] {
  return [`用 ${app} 打开这个项目目录`, `在它的 AI 对话框里给出 .hub/tasks/ 下任务书的路径，${READ_BACK}`];
}

export const IDE_TARGETS: readonly IdeTarget[] = [
  { tool: 'zcode', vendor: 'domestic', steps: cliSteps('zcode') },
  { tool: 'claude-code', vendor: 'global', steps: cliSteps('claude') },
  { tool: 'codex', vendor: 'global', steps: cliSteps('codex') },
  { tool: 'opencode', vendor: 'global', steps: cliSteps('opencode') },
  { tool: 'dsh', vendor: 'global', steps: cliSteps('dsh --profile <profile>') },
  { tool: 'trae', vendor: 'domestic', steps: ideSteps('Trae') },
  { tool: 'qoder', vendor: 'domestic', steps: ideSteps('Qoder') },
  { tool: 'catpaw', vendor: 'domestic', steps: ideSteps('CatPaw') },
];

export function ideTargetFor(tool: string): IdeTarget | null {
  return IDE_TARGETS.find((target) => target.tool === tool) ?? null;
}

/** `ide:zcode` → 'zcode'; anything else (a window name, empty, a typo) → null so
 * the caller keeps the v0.1 paste-a-package path. */
export function parseIdeTarget(raw: string | undefined): string | null {
  const match = /^ide:([a-z0-9][a-z0-9._-]*)$/i.exec(String(raw ?? '').trim());
  return match ? match[1]!.toLowerCase() : null;
}

/** Where the copy lands, relative to the project the IDE opens. */
export function hubReferencePath(task: { id: string; version: number }, dir = '.hub'): string {
  return `${dir}/tasks/${task.id}-v${task.version}.md`;
}

export function renderIdeRelayNote(ide: IdeTarget, refPath: string): string {
  return [
    `派发目标 ide:${ide.tool} —— v0.2 只落文件、不自动注入，剩下 ${ide.steps.length} 步由你完成：`,
    ...ide.steps.map((step, index) => `${index + 1}. ${step}`),
    `项目内副本：${refPath}`,
  ].join('\n');
}
