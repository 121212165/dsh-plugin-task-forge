/** Pure tests for the IDE dispatch table used by `/relay --to ide:<tool>`.
 * The tool-name list is a deliberate copy of dsh-plugin-ide-hub/src/hub/registry.ts
 * defaultRegistry(); this suite is the drift guard for that copy.
 * @module test/ide-targets */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { IDE_TARGETS, hubReferencePath, ideTargetFor, parseIdeTarget, renderIdeRelayNote } from '../src/ide-targets.ts';

test('every ide: target names a tool and tells the user how to open the book', () => {
  assert.deepEqual(IDE_TARGETS.map((target) => target.tool), ['zcode', 'claude-code', 'codex', 'opencode', 'dsh', 'trae', 'qoder', 'catpaw']);
  for (const target of IDE_TARGETS) {
    assert.ok(['domestic', 'global'].includes(target.vendor), target.tool);
    assert.ok(target.steps.length >= 2, `${target.tool} needs at least an open step and a read-back step`);
    assert.ok(target.steps.some((step) => step.includes('回读')), `${target.tool} must keep the handshake contract`);
    assert.ok(!/自动注入|已经替你/.test(target.steps.join('')), `${target.tool} must not claim automation v0.2 does not have`);
  }
  assert.equal(ideTargetFor('zcode')?.vendor, 'domestic');
  assert.equal(ideTargetFor('notreal'), null);
  assert.equal(ideTargetFor('Zcode'), null, 'lookup is by exact registry name');
});

test('parseIdeTarget only recognises ide: names', () => {
  assert.equal(parseIdeTarget('ide:zcode'), 'zcode');
  assert.equal(parseIdeTarget('IDE:Claude-Code'), 'claude-code');
  assert.equal(parseIdeTarget('窗口A'), null);
  assert.equal(parseIdeTarget('ide:'), null);
  assert.equal(parseIdeTarget(undefined), null);
  assert.equal(parseIdeTarget('ide:has space'), null);
});

test('the project copy is version-stamped and its note hands over the manual steps', () => {
  assert.equal(hubReferencePath({ id: '20261002-a3f2', version: 3 }), '.hub/tasks/20261002-a3f2-v3.md');
  assert.equal(hubReferencePath({ id: '20261002-a3f2', version: 1 }, '.hub'), '.hub/tasks/20261002-a3f2-v1.md');

  const note = renderIdeRelayNote(ideTargetFor('trae')!, 'C:\\repo\\.hub\\tasks\\20261002-a3f2-v1.md');
  assert.ok(note.includes('派发目标 ide:trae'), note);
  assert.ok(note.includes('v0.2 只落文件'), note);
  assert.ok(note.includes('1. 用 Trae 打开这个项目目录'), note);
  assert.ok(note.endsWith('项目内副本：C:\\repo\\.hub\\tasks\\20261002-a3f2-v1.md'), note);
});
