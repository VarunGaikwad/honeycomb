import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { registerTools } from '../../src/extension/register-tools.ts';
import { createToolSystem } from '../../src/tools/index.ts';
import type { ToolContext } from '../../src/types/index.ts';

const owner: ToolContext = { workingDirectory: process.cwd(), sessionId: 'owner', confirmCommand: async () => true };

test('only the owning session can inspect, send input or kill a managed process', { timeout: 5000 }, async (t) => {
  const { dispatcher, processManager } = createToolSystem();
  t.after(() => processManager.clear());
  const call = (name: string, args: Record<string, unknown>, ctx = owner) => dispatcher.dispatch({ name, arguments: args }, ctx);
  const { output: processId } = await call('terminal', { command: 'read -r line; printf "%s" "$line"; read -r stop' });
  assert.ok(processId);
  const child = processManager.get(processId, owner.sessionId)!.child;
  const exited = once(child, 'exit');
  const other = { ...owner, sessionId: 'other', confirmCommand: async () => { assert.fail('must not ask for a foreign handle'); } };
  assert.deepEqual(processManager.list(other.sessionId), []);
  for (const name of ['process', 'kill', 'terminal']) {
    const denied = await call(name, name === 'terminal' ? { processId, input: 'foreign\n' } : { processId }, other);
    assert.equal(denied.success, false);
    assert.equal(denied.output, undefined);
  }
  assert.equal((await call('process', { processId })).metadata?.running, true);
  const printed = once(child.stdout!, 'data');
  assert.equal((await call('terminal', { processId, input: 'owner-only\n' })).success, true);
  await printed;
  assert.equal((await call('process', { processId })).output, 'owner-only');
  assert.equal((await call('kill', { processId })).success, true);
  assert.deepEqual(await exited, [null, 'SIGTERM']);
  processManager.clear();
  assert.equal((await call('process', { processId })).success, false);
});

test('Pi boundary events invalidate handles and prevent approved stale calls from spawning', { timeout: 5000 }, async () => {
  const defs = new Map<string, any>();
  const hooks = new Map<string, () => void>();
  registerTools({ registerTool: (tool: any) => defs.set(tool.name, tool), on: (name: string, handler: () => void) => hooks.set(name, handler) } as never);
  const ctx = { cwd: process.cwd(), hasUI: true, mode: 'rpc', ui: { confirm: async () => true }, sessionManager: { getSessionId: () => 'same-id' } };
  const call = (name: string, args: Record<string, unknown>, context = ctx) => defs.get(name).execute('call-id', args, undefined, undefined, context);
  for (const event of ['session_tree', 'session_start', 'session_shutdown']) {
    const started = await call('background', { command: 'exec sleep 30' });
    assert.equal(started.isError, undefined);
    const processId = started.details.metadata.processId;
    assert.equal((await call('process', { processId })).isError, undefined);
    hooks.get(event)!();
    assert.equal((await call('process', { processId })).isError, true);
  }
  hooks.get('session_start')!();
  let entered!: () => void;
  const requested = new Promise<void>(resolve => { entered = resolve; });
  let approve!: (value: boolean) => void;
  const approval = new Promise<boolean>(resolve => { approve = resolve; });
  const pending = call('background', { command: 'exec sleep 30' }, { ...ctx, ui: { confirm: () => { entered(); return approval; } } });
  await requested;
  hooks.get('session_tree')!();
  approve(true);
  const cancelled = await pending;
  assert.equal(cancelled.details.errorCode, 'OPERATION_CANCELLED');
  assert.equal(cancelled.details.metadata, undefined);
  hooks.get('session_shutdown')!();
});

test('clearing the manager retires live handles and terminates their children', { timeout: 5000 }, async (t) => {
  const { processManager } = createToolSystem();
  t.after(() => processManager.clear());
  const { id, process: managed } = processManager.start('sleep 30 & wait', owner);
  const closed = once(managed.child, 'close');
  processManager.clear();
  assert.equal(processManager.get(id, owner.sessionId), undefined);
  assert.deepEqual(await closed, [null, 'SIGKILL']);
});

test('foreground cancellation terminates the managed child and does not return its output', { timeout: 5000 }, async (t) => {
  const { dispatcher, processManager } = createToolSystem();
  t.after(() => processManager.clear());
  const stop = new AbortController();
  const pending = dispatcher.dispatch({ name: 'bash', arguments: { command: 'exec sleep 30' } }, { ...owner, signal: stop.signal });
  for (let retries = 0; retries < 100 && !processManager.list(owner.sessionId).length; retries++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const [entry] = processManager.list(owner.sessionId);
  const exited = once(processManager.get(entry!.id, owner.sessionId)!.child, 'exit');
  stop.abort();
  const result = await pending;
  assert.equal(result.errorCode, 'OPERATION_CANCELLED');
  assert.equal(result.output, undefined);
  assert.deepEqual(await exited, [null, 'SIGKILL']);
});
