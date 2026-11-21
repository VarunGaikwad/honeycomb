import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPermissionModes } from '../src/extension/permission-modes/index.ts';

test('mode cycle notifies subscribers and gate fails closed', async () => {
  let shortcut: () => void = () => { throw new Error('missing shortcut'); };
  let gate: (...args: any[]) => Promise<any> = async () => { throw new Error('missing gate'); };
  const controller = createPermissionModes({
    registerShortcut(_key: string, options: any) { shortcut = options.handler; },
    on(event: string, handler: any) { if (event === 'tool_call') gate = handler; },
  } as any);
  let changes = 0;
  const unsubscribe = controller.subscribe(() => changes++);
  assert.equal(controller.label, 'Manual');
  assert.equal((await gate({ toolName: 'write', input: {} }, { hasUI: false })).block, true);
  shortcut(); assert.equal(controller.label, 'Edits');
  shortcut(); assert.equal(controller.label, 'Plan');
  assert.equal((await gate({ toolName: 'write', input: {} }, { hasUI: true })).block, true);
  shortcut(); assert.equal(controller.label, 'Auto');
  shortcut(); assert.equal(controller.label, 'Manual');
  assert.equal(changes, 4);
  unsubscribe(); shortcut(); assert.equal(changes, 4);
  assert.equal((await gate({ toolName: 'write', input: { path: '../outside-file' } }, { cwd: process.cwd(), hasUI: true, ui: { select: async () => { throw new Error('closed'); } } })).block, true);
});
