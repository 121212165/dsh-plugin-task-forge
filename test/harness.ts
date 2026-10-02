/** Shared assembly-layer harness: a scripted mock dsh context that the real
 * `apply()` wires against, so command handlers, the tool, and the prompt
 * section are exercised over a real temp directory — the wire coverage the
 * family audit found missing everywhere. Pattern adopted from dsh-auto-review's
 * mountHarness (222★), rebuilt on node:test instead of vitest.
 * @module test/harness */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

export interface CapturedCommand {
  name: string;
  description: string;
  input?: { hint?: string };
  handler: (args: { rawInput?: string }) => { kind: string; text: string };
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
  const commands: CapturedCommand[] = [];
  const tools: CapturedTool[] = [];
  const sections: CapturedSection[] = [];
  const followups: CapturedFollowup[] = [];

  const agent = {
    followup(message: { content?: Array<{ type: string; text?: string }>; source?: unknown }) {
      const first = message.content?.[0];
      followups.push({ text: typeof first?.text === 'string' ? first.text : '', message });
    },
  };

  const ctx = {
    logger(_name: string) {
      return { info() {}, warn() {} };
    },
    commands: {
      register(definition: CapturedCommand) {
        commands.push(definition);
      },
    },
    tools: {
      register(definition: CapturedTool) {
        tools.push(definition);
      },
    },
    systemPrompt: {
      section(section: CapturedSection) {
        sections.push(section);
      },
    },
    agents: options.agent === false ? { get: () => undefined, list: () => [] } : { get: () => undefined, list: () => [agent] },
  };

  const dataPath = mkdtempSync(join(tmpdir(), 'task-forge-wire-'));
  after(() => rmSync(dataPath, { recursive: true, force: true }));

  // apply once per harness — a second call would double-register commands.
  let applied: Promise<void> | null = null;

  const harness: Harness = {
    commands,
    tools,
    sections,
    followups,
    dataPath,
    apply(config: Record<string, unknown>) {
      applied ??= import('../src/plugin.ts').then(({ apply }) => apply(ctx as never, { enabled: true, hubPath: join(dataPath, 'hub'), limit: 8, maxChars: 900, order: 690, ...config } as never));
      return applied;
    },
    command(name: string): CapturedCommand {
      const found = commands.find((candidate) => candidate.name === name);
      if (!found) throw new Error(`command ${name} was never registered`);
      return found;
    },
    tool(name: string): CapturedTool {
      const found = tools.find((candidate) => candidate.name === name);
      if (!found) throw new Error(`tool ${name} was never registered`);
      return found;
    },
    sectionText(): string {
      const found = sections.find((candidate) => candidate.name === 'task-forge');
      if (!found) throw new Error('task-forge section was never registered');
      return found.text();
    },
  };
  return harness;
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
