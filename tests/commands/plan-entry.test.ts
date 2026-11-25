import assert from 'node:assert/strict';
import test from 'node:test';
import { createPermissionModes } from '../../src/extension/permission-modes/index.ts';

test('plan entry restricts tools before persisting and is idempotent', () => {
  let active = ['read', 'glob', 'write', 'bash'];
  const entries: unknown[] = [];
  const controller = createPermissionModes({
    on() {}, registerShortcut() {}, registerTool() {}, registerCommand() {},
    getActiveTools: () => active,
    setActiveTools: (tools: string[]) => { active = tools; },
    appendEntry: (_name: string, data: unknown) => { assert.deepEqual(active, ['read', 'glob', 'plan_note']); entries.push(data); },
  } as never);
  assert.equal(controller.enterPlan(), true);
  assert.equal(controller.mode, 'plan');
  assert.deepEqual(active, ['read', 'glob', 'plan_note']);
  assert.equal(entries.length, 1);
  assert.equal(controller.enterPlan(), true);
  assert.equal(entries.length, 1);
});
