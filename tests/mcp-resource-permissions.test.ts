import assert from 'node:assert/strict';
import test from 'node:test';
import { createPermissionModes } from '../src/extension/permission-modes/index.ts';
import { MCP_RESOURCE_SERVER_FLAG } from '../src/extension/permission-modes/mcp-resources.ts';
import { decidePermission } from '../src/extension/permission-modes/policy.ts';

const cwd = process.cwd();
const server = 'docs';
const target = { server, uri: 'docs://guide/install' };

test('MCP policy requires explicit server and bounded arguments, honors deny rules, and always asks', () => {
  const read = 'read_mcp_resource';
  for (const tool of ['list_mcp_resources', 'list_mcp_resource_templates']) {
    assert.equal(decidePermission('default', tool, {}, cwd).action, 'deny');
    assert.equal(decidePermission('default', tool, { server, cursor: 'page-2' }, cwd).action, 'ask');
    assert.equal(decidePermission('default', tool, { server, cursor: 'x'.repeat(2049) }, cwd).action, 'deny');
  }
  assert.equal(decidePermission('default', read, { server }, cwd).action, 'deny');
  assert.equal(decidePermission('default', read, { ...target, uri: 'docs://guide\nother' }, cwd).action, 'deny');
  assert.equal(decidePermission('bypassPermissions', read, target, cwd, { allow: [`${read}:*`] }).action, 'ask');
  assert.equal(decidePermission('default', read, target, cwd, { deny: [`${read}:docs`] }).action, 'deny');
  assert.equal(decidePermission('default', read, target, cwd, { deny: [`${read}:docs://guide/*`] }).action, 'deny');
  for (const mode of ['plan', 'dontAsk']) assert.equal(decidePermission(mode, read, target, cwd).action, 'deny');
});

test('Pi resource gate confirms scoped calls, including nested ones, and rejects stale approvals', async () => {
  const hooks = new Map<string, Function>();
  let selectedServer: string | undefined;
  let trusted = true;
  let onPrompt = () => 'Allow once';
  const previews: string[] = [];
  const pi = {
    on: (name: string, cb: Function) => hooks.set(name, cb), registerFlag() {}, registerCommand() {}, registerShortcut() {},
    getFlag: (name: string) => name === MCP_RESOURCE_SERVER_FLAG ? selectedServer : undefined,
    getActiveTools: () => [], setActiveTools() {}, appendEntry() {},
  };
  const permissions = createPermissionModes(pi as never);
  const context = { cwd, mode: 'rpc', hasUI: true, isProjectTrusted: () => trusted,
    ui: { notify() {}, select: async (preview: string) => { previews.push(preview); return onPrompt(); } } };
  const call = (toolName: string, input: unknown, nested = false) => hooks.get('tool_call')!({
    toolName, input, toolCallId: 'id', ...(nested ? { parentToolCallId: 'parent' } : {}),
  }, context);
  assert.equal((await call('read_mcp_resource', target)).block, true);
  selectedServer = server;
  assert.equal((await call('list_mcp_resources', {})).block, true);
  assert.equal((await call('read_mcp_resource', { ...target, server: 'other' })).block, true);
  trusted = false;
  assert.equal((await call('read_mcp_resource', target)).block, true);
  trusted = true;
  context.hasUI = false;
  assert.equal((await call('read_mcp_resource', target)).block, true);
  context.hasUI = true;
  assert.equal(previews.length, 0);
  assert.equal(await call('list_mcp_resources', { server }), undefined);
  assert.equal(await call('read_mcp_resource', target, true), undefined);
  assert.match(previews.at(-1)!, /Server: docs[\s\S]*URI: docs:\/\/guide\/install/);
  onPrompt = () => 'Deny';
  assert.equal((await call('read_mcp_resource', target)).block, true);
  const changing = { ...target };
  onPrompt = () => { changing.uri = 'docs://different'; return 'Allow once'; };
  assert.equal((await call('read_mcp_resource', changing)).block, true);
  onPrompt = () => { trusted = false; return 'Allow once'; };
  assert.equal((await call('read_mcp_resource', target)).block, true);
  trusted = true;
  assert.equal(permissions.enterPlan(), true);
  assert.equal((await call('read_mcp_resource', target)).block, true);
  assert.equal(previews.length, 5);
});
