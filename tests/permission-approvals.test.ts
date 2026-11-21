import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPermissionModes } from '../src/extension/permission-modes/index.ts';

test('session approval is exact, rechecks policy, and clears on branch change', async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  createPermissionModes({ registerShortcut() {}, on(name: string, handler: any) { handlers.set(name, handler); } } as any);
  const gate = handlers.get('tool_call')!;
  let prompts = 0;
  const ctx = { cwd: process.cwd(), hasUI: true, ui: { select: async () => { prompts++; return 'Allow exact call for session'; } } };
  const call = { toolName: 'write', input: { path: 'unprotected.txt', content: 'one' } };
  assert.equal(await gate(call, ctx), undefined);
  assert.equal(await gate(call, ctx), undefined);
  assert.equal(prompts, 1);
  assert.equal(await gate({ ...call, input: { ...call.input, content: 'two' } }, ctx), undefined);
  assert.equal(prompts, 2);
  assert.equal((await gate({ ...call, input: { path: '.env', content: 'one' } }, ctx)).block, true);
  handlers.get('session_tree')!();
  assert.equal(await gate(call, ctx), undefined);
  assert.equal(prompts, 3);
  const command = { toolName: 'bash', input: { command: 'echo ok' } };
  assert.equal((await gate(command, ctx)).block, true);
});
