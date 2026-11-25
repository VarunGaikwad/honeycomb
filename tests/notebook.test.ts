import assert from 'node:assert/strict';
import { link, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createPermissionModes } from '../src/extension/permission-modes/index.ts';
import { decidePermission } from '../src/extension/permission-modes/policy.ts';
import { registerTools } from '../src/extension/register-tools.ts';
import { createToolSystem } from '../src/tools/index.ts';

const notebook = '\ufeff{\r\n "metadata": {"keep":90071992547409933},\r\n "nbformat":4, "nbformat_minor":5,\r\n "cells":[{"cell_type":"markdown","id":"first","metadata":{},"source":"Title"},' +
  '{"cell_type":"code","id":"second","metadata":{"source":"nested"},"execution_count":8,"outputs":[{"text":"keep"}],"sourc\\u0065":["old\\n", "line"]}]\r\n}\r\n';
const args = { path: 'demo.ipynb', cell_index: 1, old_source: 'old\nline', new_source: 'new\ncell' };

async function fixture(t: TestContext, source = notebook) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'bi-notebook-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const file = path.join(cwd, args.path);
  await writeFile(file, source);
  const { dispatcher } = createToolSystem();
  const ctx = { workingDirectory: cwd, sessionId: 'notebook-test', confirmDestructive: async () => true };
  const call = (name: string, input: Record<string, unknown> = {}) => dispatcher.dispatch({ name, arguments: input }, ctx);
  return { cwd, file, ctx, dispatcher, call };
}

test('notebook editing preserves unrelated bytes (including BOM, metadata and output) and undo restores exact original', async t => {
  const { file, call } = await fixture(t);
  assert.match((await call('notebook_edit', args)).error ?? '', /Read the notebook/);
  assert.equal((await call('read', { path: args.path, limit: 1 })).success, true);
  assert.equal((await call('notebook_edit', args)).success, true);
  const updated = notebook.replace('["old\\n", "line"]', '["new\\n","cell"]');
  assert.equal(await readFile(file, 'utf8'), updated);
  assert.match((await call('notebook_edit', { ...args, old_source: args.new_source, new_source: '' })).error ?? '', /Read the notebook/);
  assert.equal((await call('undo')).success, true);
  assert.equal(await readFile(file, 'utf8'), notebook);
  await call('read', { path: args.path });
  assert.equal((await call('notebook_edit', { ...args, cell_index: 0, old_source: 'Title', new_source: '' })).success, true);
  assert.equal(await readFile(file, 'utf8'), notebook.replace('"source":"Title"', '"source":""'));
});

test('malformed, stale, unsafe and unapproved edits leave the notebook untouched', async t => {
  const { cwd, file, call, dispatcher, ctx } = await fixture(t);
  await call('read', { path: args.path });
  for (const [input, error] of [[{ ...args, cell_index: 2 }, /out of range/], [{ ...args, old_source: 'unmatched' }, /does not match/]] as const) {
    assert.match((await call('notebook_edit', input)).error ?? '', error);
  }
  assert.match((await dispatcher.dispatch({ name: 'notebook_edit', arguments: args }, { ...ctx, confirmDestructive: undefined })).error ?? '', /not approved/);
  const edited = await dispatcher.dispatch({ name: 'notebook_edit', arguments: args }, {
    ...ctx, confirmDestructive: async () => { await writeFile(file, notebook + ' '); return true; },
  });
  assert.match(edited.error ?? '', /changed before/);
  assert.equal(await readFile(file, 'utf8'), notebook + ' ');
  assert.match((await call('notebook_edit', args)).error ?? '', /changed since/);
  const duplicate = notebook.replace('"sourc\\u0065":', '"source":"other","sourc\\u0065":');
  for (const content of ['{', '{}', duplicate, ' '.repeat(1024 * 1024 + 1)]) {
    await writeFile(file, content);
    await call('read', { path: args.path });
    assert.equal((await call('notebook_edit', args)).success, false);
    assert.equal(await readFile(file, 'utf8'), content);
  }
  await writeFile(file, notebook);
  await call('read', { path: args.path });
  await symlink(file, path.join(cwd, 'alias.ipynb'));
  assert.match((await call('notebook_edit', { ...args, path: 'alias.ipynb' })).error ?? '', /symlinked/);
  await link(file, path.join(cwd, 'hard.ipynb'));
  assert.match((await call('notebook_edit', args)).error ?? '', /regular unlinked/);
  assert.equal(await readFile(file, 'utf8'), notebook);
});

test('Pi requires one exact approval with a cell preview, and Plan/No prompts block edits', async t => {
  const { cwd, file } = await fixture(t);
  const hooks = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  const pi = {
    on: (name: string, fn: Function) => hooks.set(name, [...hooks.get(name) ?? [], fn]),
    registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand() {}, registerShortcut() {},
  };
  const controller = createPermissionModes(pi as never);
  registerTools(pi as never, controller);
  const prompts: string[] = [];
  const ctx = { cwd, hasUI: true, mode: 'rpc', sessionManager: { getSessionId: () => 'notebook-session' },
    ui: { select: async (title: string) => { prompts.push(title); return 'Allow once'; } } };
  const execute = (name: string, input: unknown) => tools.get(name).execute('edit-id', input, undefined, undefined, ctx);
  await execute('read', { path: args.path });
  assert.equal((await execute('notebook_edit', args)).isError, true);
  for (const hook of hooks.get('tool_call')!) {
    assert.equal(await hook({ toolName: 'notebook_edit', input: args, toolCallId: 'edit-id' }, ctx), undefined);
  }
  assert.equal((await execute('notebook_edit', args)).isError, undefined);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /Cell index: 1.*\n- old\n- line\n\+ new\n\+ cell/);
  assert.notEqual(await readFile(file, 'utf8'), notebook);
  for (const mode of ['plan', 'dontAsk']) assert.equal(decidePermission(mode, 'notebook_edit', args, cwd).action, 'deny');
  assert.equal(decidePermission('acceptEdits', 'notebook_edit', args, cwd).action, 'ask');
  assert.equal(decidePermission('auto', 'notebook_edit', args, cwd, { deny: ['notebook_edit:demo.ipynb'] }).action, 'deny');
});
