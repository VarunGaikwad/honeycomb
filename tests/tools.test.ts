import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAgentTools } from '../src/tools/agent.ts';
import { createExecutionTools } from '../src/tools/execution.ts';
import { createFileSystemTools } from '../src/tools/filesystem.ts';
import { createGitTools } from '../src/tools/git.ts';
import { ToolDispatcher } from '../src/tools/dispatcher.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { Tool, ToolContext } from '../src/tools/types.ts';

const execFile = promisify(execFileCallback);

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bi-tools-'));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

function context(workingDirectory: string, extras: Partial<ToolContext> = {}): ToolContext {
  return { sessionId: 'test-session', workingDirectory, ...extras };
}

test('registry rejects duplicate names and exposes definitions', () => {
  const registry = new ToolRegistry();
  const tool: Tool = { name: 'hello', description: 'test', parameters: {}, execute: async () => ({ success: true }) };
  registry.register(tool);
  assert.equal(registry.get('hello'), tool);
  assert.deepEqual(registry.definitions(), [{ name: 'hello', description: 'test', parameters: {} }]);
  assert.throws(() => registry.register(tool), /already registered/);
});

test('dispatcher validates arguments, catches failures, and preserves sequential order', async () => {
  const registry = new ToolRegistry();
  const seen: number[] = [];
  registry.register({
    name: 'record', description: 'record', parameters: {},
    validate: (args): args is { n: number } => typeof args === 'object' && args !== null &&
      typeof (args as { n?: unknown }).n === 'number',
    execute: async ({ n }) => { seen.push(n); return { success: true, output: String(n) }; },
  });
  const dispatcher = new ToolDispatcher(registry);
  const ctx = context('/tmp');
  assert.equal((await dispatcher.dispatch({ name: 'record', arguments: { n: 'bad' } }, ctx)).errorCode, 'INVALID_ARGUMENTS');
  assert.equal((await dispatcher.dispatch({ name: 'absent', arguments: {} }, ctx)).errorCode, 'TOOL_NOT_FOUND');
  const results = await dispatcher.dispatchSequential([
    { name: 'record', arguments: { n: 1 } },
    { name: 'record', arguments: { n: 2 } },
  ], ctx);
  assert.deepEqual(seen, [1, 2]);
  assert.deepEqual(results.map((result) => result.output), ['1', '2']);
});

test('filesystem tools confine paths and require approval before deletion', async () => {
  await withTempDir(async (root) => {
    const outside = path.join(root, 'outside');
    const project = path.join(root, 'project');
    await mkdir(project);
    await writeFile(outside, 'outside data');
    await symlink(outside, path.join(project, 'escape'));
    const registry = new ToolRegistry();
    createFileSystemTools().forEach((tool) => registry.register(tool));
    const dispatcher = new ToolDispatcher(registry);
    const ctx = context(project);
    assert.equal((await dispatcher.dispatch({ name: 'read', arguments: { path: '../outside' } }, ctx)).success, false);
    assert.equal((await dispatcher.dispatch({ name: 'read', arguments: { path: 'escape' } }, ctx)).success, false);
    assert.equal((await dispatcher.dispatch({ name: 'write', arguments: { path: 'new.txt', content: 'hello' } }, ctx)).success, true);
    assert.equal((await readFile(path.join(project, 'new.txt'), 'utf8')), 'hello');
    assert.equal((await dispatcher.dispatch({ name: 'write', arguments: { path: 'nested/deep/file.txt', content: 'nested' } }, ctx)).success, true);
    assert.equal(await readFile(path.join(project, 'nested/deep/file.txt'), 'utf8'), 'nested');
    assert.equal((await dispatcher.dispatch({ name: 'delete', arguments: { path: 'new.txt' } }, ctx)).success, false);
    const approved = context(project, { confirmDestructive: async () => true });
    assert.equal((await dispatcher.dispatch({ name: 'delete', arguments: { path: 'new.txt' } }, approved)).success, true);
  });
});

test('shell execution honors command policy and cancellation', async () => {
  const noPolicy = createExecutionTools();
  const noPolicyRegistry = new ToolRegistry();
  noPolicy.tools.forEach((tool) => noPolicyRegistry.register(tool));
  const deniedByDefault = await new ToolDispatcher(noPolicyRegistry).dispatch(
    { name: 'bash', arguments: { command: 'echo unsafe' } },
    context(process.cwd()),
  );
  assert.equal(deniedByDefault.success, false);

  const { tools } = createExecutionTools(undefined, { allowCommand: () => false });
  const registry = new ToolRegistry();
  tools.forEach((tool) => registry.register(tool));
  const result = await new ToolDispatcher(registry).dispatch(
    { name: 'bash', arguments: { command: 'echo unsafe' } },
    context(process.cwd()),
  );
  assert.equal(result.success, false);
  assert.match(result.error ?? '', /denied/);

  const controller = new AbortController();
  controller.abort();
  const allowed = createExecutionTools(undefined, { allowCommand: () => true });
  const allowedRegistry = new ToolRegistry();
  const dispatcher = new ToolDispatcher(allowedRegistry);
  allowed.tools.forEach((tool) => allowedRegistry.register(tool));
  const cancelled = await dispatcher.dispatch(
    { name: 'bash', arguments: { command: 'echo should-not-run' } },
    context(process.cwd(), { signal: controller.signal }),
  );
  assert.equal(cancelled.errorCode, 'OPERATION_CANCELLED');
});

test('apply_patch undo restores agent changes and refuses to overwrite later edits', async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, 'file.txt'), 'before');
    const registry = new ToolRegistry();
    createAgentTools().forEach((tool) => registry.register(tool));
    const patchTool = registry.get('apply_patch')!;
    assert.deepEqual((patchTool.parameters.properties as Record<string, any>).edits.items.required, [
      'path', 'oldText', 'newText',
    ]);
    const dispatcher = new ToolDispatcher(registry);
    const ctx = context(dir);
    const patch = { name: 'apply_patch', arguments: { edits: [{ path: 'file.txt', oldText: 'before', newText: 'after' }] } };
    assert.equal((await dispatcher.dispatch(patch, ctx)).success, true);
    assert.equal((await dispatcher.dispatch({ name: 'undo', arguments: {} }, ctx)).success, true);
    assert.equal(await readFile(path.join(dir, 'file.txt'), 'utf8'), 'before');
    assert.equal((await dispatcher.dispatch(patch, ctx)).success, true);
    await writeFile(path.join(dir, 'file.txt'), 'user edit');
    const undo = await dispatcher.dispatch({ name: 'undo', arguments: {} }, ctx);
    assert.equal(undo.success, false);
    assert.equal(await readFile(path.join(dir, 'file.txt'), 'utf8'), 'user edit');
    const duplicate = await dispatcher.dispatch({
      name: 'apply_patch',
      arguments: { edits: [
        { path: 'file.txt', oldText: 'user', newText: 'other' },
        { path: 'file.txt', oldText: 'edit', newText: 'change' },
      ] },
    }, ctx);
    assert.equal(duplicate.success, false);
  });
});

test('git tools invoke git safely in the configured working directory', async () => {
  await withTempDir(async (dir) => {
    await execFile('git', ['init', '-q'], { cwd: dir });
    await writeFile(path.join(dir, 'file.txt'), 'tracked');
    const registry = new ToolRegistry();
    createGitTools().forEach((tool) => registry.register(tool));
    const result = await new ToolDispatcher(registry).dispatch(
      { name: 'git_status', arguments: {} },
      context(dir),
    );
    assert.equal(result.success, true);
    assert.match(result.output ?? '', /file\.txt/);
  });
});
