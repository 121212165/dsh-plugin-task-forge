/** Shared assembly-layer harness: a scripted mock dsh context that the real
 * `apply()` wires against, so command handlers, the tool, and the prompt
 * section are exercised over a real temp directory. The mock itself lives in
 * @dsh-family/kit; this file adds task-forge's captures, config defaults and
 * the command helpers every test in this repo uses.
 * @module test/harness */

import { join } from 'node:path';

import { applyOnce, createMockCtx, tempDir } from '@dsh-family/kit/kit/test-harness';

export interface CapturedCommand {
  name: string;
  description: string;
  input?: { hint?: string };
  handler: (args: { rawInput?: string | undefined }) => { kind: string; text: string };
}

export interface CapturedTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string>;
  presentCall?: (args: Record<string, unknown>) => { card: string; title: string; kind?: string; rawInput?: unknown; locations?: Array<{ path: string }> };
  presentResult?: (args: Record<string, unknown>, result: string) => { card: string; title: string; content?: Array<{ type: string; text?: string }> };
}

export interface CapturedSection {
  name: string;
  order: number;
  text: () => string;
}

export interface CapturedFollowup {
  text: string;
  message: unknown;
}

export interface Harness {
  commands: CapturedCommand[];
  tools: CapturedTool[];
  sections: CapturedSection[];
  followups: CapturedFollowup[];
  /** Directory backing this mount's ForgeStore — wiped after tests. */
  dataPath: string;
  /** Mounts the real apply() against this harness once; later calls are no-ops. */
  apply(config: Record<string, unknown>): Promise<void>;
  command(name: string): CapturedCommand;
  tool(name: string): CapturedTool;
  sectionText(): string;
}

export interface HarnessOptions {
  /** false → no live session, so /forge must fall back to the paste-me path. */
  agent?: boolean;
}

export function makeHarness(options: HarnessOptions = {}): Harness {
  const followups: CapturedFollowup[] = [];

  const agent = {
    followup(message: { content?: Array<{ type: string; text?: string }>; source?: unknown }) {
      const first = message.content?.[0];
      followups.push({ text: typeof first?.text === 'string' ? first.text : '', message });
    },
  };

  const mock = createMockCtx<CapturedCommand, CapturedTool, CapturedSection>({
    agents: options.agent === false ? { get: () => undefined, list: () => [] } : { get: () => undefined, list: () => [agent] },
  });

  const dataPath = tempDir('task-forge-wire-');

  // apply once per harness — a second call would double-register commands.
  // The first call decides the mount config; later calls reuse it.
  let pending: Record<string, unknown> = {};
  let mounted = false;
  const applied = applyOnce(() =>
    import('../src/plugin.ts').then(({ apply }) => apply(mock.ctx as never, {
      enabled: true,
      hubPath: join(dataPath, 'hub'),
      // never let a test read the real ~/.dsh/quota/summary.json
      quotaSummaryPath: join(dataPath, 'no-quota.json'),
      // ...or the real ~/.dsh/quota/history.json
      quotaHistoryPath: join(dataPath, 'no-history.json'),
      limit: 8,
      maxChars: 900,
      order: 690,
      ...pending,
    } as never)),
  );

  return {
    commands: mock.commands,
    tools: mock.tools,
    sections: mock.sections,
    followups,
    dataPath,
    apply(config: Record<string, unknown>) {
      if (!mounted) {
        mounted = true;
        pending = config;
      }
      return applied();
    },
    command: mock.command,
    tool: mock.tool,
    sectionText(): string {
      return mock.section('task-forge').text();
    },
  };
}

/** Convenience: fire a command and assert+return its success text. */
export async function succeed(harness: Harness, name: string, rawInput?: string): Promise<string> {
  await harness.apply({});
  const result = harness.command(name).handler({ rawInput });
  if (result.kind !== 'success') throw new Error(`expected success from /${name}, got ${result.kind}: ${result.text}`);
  return result.text;
}

/** Fire a command on an already-mounted harness, returning the raw result. */
export function fire(harness: Harness, name: string, rawInput?: string): { kind: string; text: string } {
  return harness.command(name).handler({ rawInput });
}

/** Fire a command and unwrap its text, asserting it succeeded. */
export function fireOk(harness: Harness, name: string, rawInput?: string): string {
  const result = fire(harness, name, rawInput);
  if (result.kind !== 'success') throw new Error(`expected success from /${name}, got ${result.kind}: ${result.text}`);
  return result.text;
}

/** Fire forge_write and unwrap the string result. */
export async function toolResult(harness: Harness, name: string, args: Record<string, unknown>): Promise<string> {
  await harness.apply({});
  return harness.tool(name).execute(args);
}
