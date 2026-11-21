import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPermissionModes } from '../src/extension/permission-modes/index.ts';
import { decidePermission } from '../src/extension/permission-modes/policy.ts';
import { planNotePath, writePlanNote } from '../src/extension/permission-modes/plan-note.ts';
import { installTui } from '../src/tui/index.ts';

function host(flag?: string, reviewer?: any) {
  const events = new Map<string, any[]>(), entries: any[] = [];
  let shortcut: any, tool: any, active = ['read', 'write', 'bash', 'goal_report'];
  const pi: any = {
    registerFlag() {}, getFlag() { return flag; },
    registerShortcut(_key: string, opts: any) { shortcut = opts.handler; },
    registerTool(definition: any) { tool = definition; },
    on(name: string, handler: any) { events.set(name, [...(events.get(name) ?? []), handler]); },
    appendEntry(customType: string, data: unknown) { entries.push({ type: 'custom', customType, data }); },
    getActiveTools() { return [...active]; }, setActiveTools(names: string[]) { active = [...names]; },
  };
  const controller = createPermissionModes(pi, reviewer);
  const emit = async (name: string, event: any, ctx: any) => { let output: any; for (const handler of events.get(name) ?? []) output = await handler(event, ctx); return output; };
  return { controller, emit, entries, shortcut: () => shortcut(), get tool() { return tool; }, get active() { return active; } };
}
function context(cwd: string, selected?: string, ui = true) {
  const branch: any[] = [];
  return { cwd, hasUI: ui, sessionManager: { getBranch: () => branch, getSessionId: () => 'session-1' },
    ui: { select: async () => selected, confirm: async () => false, notify() {} }, branch };
}

test('modes apply path, rule and Plan boundaries in every mode', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'bi-permission-'));
  try {
    await mkdir(path.join(cwd, 'dir')); await writeFile(path.join(cwd, 'dir', '.env'), 'secret');
    await symlink(os.tmpdir(), path.join(cwd, 'escape'));
    for (const mode of ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']) {
      assert.equal(decidePermission(mode, 'write', { path: '.git/config' }, cwd).action, 'deny');
      assert.equal(decidePermission(mode, 'delete', { path: 'dir' }, cwd).action, 'deny');
      assert.notEqual(decidePermission(mode, 'write', { path: 'escape/file' }, cwd).action, 'allow');
      assert.notEqual(decidePermission(mode, 'unknown', {}, cwd, { allow: ['unknown:*'] }).action, 'allow');
    }
    assert.equal(decidePermission('plan', 'read', { path: 'file' }, cwd).action, 'allow');
    assert.equal(decidePermission('plan', 'read', { path: 'file', offset: 'bad' }, cwd).action, 'deny');
    assert.equal(decidePermission('plan', 'goal_report', {}, cwd).action, 'deny');
    assert.equal(decidePermission('plan', 'goal_report', { status: 'continue', summary: 'Investigated' }, cwd).action, 'allow');
    assert.equal(decidePermission('plan', 'write', { path: 'file' }, cwd).action, 'deny');
    assert.equal(decidePermission('acceptEdits', 'apply_patch', { edits: [{ path: 'file', oldText: 'a', newText: 'b' }, { path: '../outside', oldText: 'a', newText: 'b' }] }, cwd).action, 'ask');
    assert.equal(decidePermission('bypassPermissions', 'write', { path: 'file', content: '' }, cwd, { ask: ['write:*'] }).action, 'ask');
    assert.equal(decidePermission('dontAsk', 'read', { path: '.env' }, cwd).action, 'deny');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('Plan note is session-specific, refuses symlinks, and approval restores tools without a kickoff', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'bi-plan-'));
  try {
    const h = host(), ctx = context(cwd, 'Start in Edits');
    await h.emit('session_start', {}, ctx);
    h.shortcut(); h.shortcut();
    assert.equal(h.controller.mode, 'plan');
    assert.deepEqual(h.active, ['read', 'goal_report', 'plan_note']);
    await h.tool.execute('1', { content: 'Plan' }, undefined, undefined, ctx);
    assert.equal(await readFile(planNotePath(cwd, 'session-1'), 'utf8'), 'Plan');
    assert.notEqual(planNotePath(cwd, 'session-1'), planNotePath(cwd, 'session-2'));
    await h.emit('agent_before_settle', { outcome: 'completed', entries: [] }, ctx);
    assert.equal(h.controller.mode, 'acceptEdits');
    assert.deepEqual(h.active, ['read', 'write', 'bash', 'goal_report']);
    assert.throws(() => planNotePath(cwd, '../other'));
    await symlink(os.tmpdir(), path.join(cwd, '.pi', 'plans', 'bad.md'));
    await assert.rejects(writePlanNote(cwd, 'bad', 'bad'));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('restricted launch choices, branch restoration and reviewer failures fail closed', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'bi-mode-'));
  try {
    const bypass = host('bypassPermissions');
    await assert.rejects(bypass.emit('session_start', {}, context(cwd, undefined, false)));
    const noPrompts = host('dontAsk'), ctx = context(cwd);
    await noPrompts.emit('session_start', {}, ctx);
    assert.equal(noPrompts.controller.mode, 'dontAsk');
    assert.equal((await noPrompts.emit('tool_call', { toolName: 'write', input: { path: 'x' } }, ctx)).block, true);
    const h = host(undefined, { reviewer: () => new Promise(() => {}), reviewerTimeoutMs: 5 });
    await h.emit('session_start', {}, ctx);
    h.shortcut(); h.shortcut(); h.shortcut();
    assert.equal(h.controller.mode, 'auto');
    assert.equal((await h.emit('tool_call', { toolName: 'bash', input: { command: 'pwd' } }, ctx)).block, true);
    ctx.branch.push({ type: 'custom', customType: 'bi.permission-mode', data: { mode: 'bypassPermissions' } });
    await h.emit('session_tree', {}, ctx);
    assert.equal(h.controller.mode, 'default');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('footer redraws on mode change, retains a narrow label and unsubscribes', () => {
  let footer: any, notify: any, unsubscribed = false, renders = 0;
  const controller = { label: 'Manual', subscribe(fn: any) { notify = fn; return () => { unsubscribed = true; }; } };
  const ctx: any = { cwd: process.cwd(), sessionManager: { getBranch: () => [] }, ui: { setHeader() {}, setFooter(factory: any) { footer = factory({ requestRender() { renders++; } }, { fg: (_: any, text: string) => text }, { onBranchChange: () => () => {}, getGitBranch: () => undefined }); } } };
  installTui(ctx, undefined, controller);
  assert.match(footer.render(12)[0], /Manual/);
  controller.label = 'Plan'; notify(); assert.equal(renders, 1);
  assert.match(footer.render(80)[0], /Mode: Plan/);
  footer.dispose(); assert.equal(unsubscribed, true);
});

test('plan approval composes with goal continuation without starting another turn', async () => {
  const { registerGoalCommand } = await import('../src/commands/goal/index.ts');
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'bi-plan-goal-'));
  try {
    const handlers = new Map<string, any[]>(), entries: any[] = [], tools = new Map<string, any>();
    let shortcut: any, kickoff = 0, active = ['read', 'write', 'goal_report'];
    const pi: any = {
      on(name: string, fn: any) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
      registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand() {}, registerFlag() {}, getFlag() {},
      registerShortcut(_key: string, options: any) { shortcut = options.handler; },
      getActiveTools() { return active; }, setActiveTools(names: string[]) { active = names; },
      appendEntry(customType: string, data: any) { entries.push({ type: 'custom', customType, data }); },
      sendUserMessage() { kickoff++; },
    };
    const mode = createPermissionModes(pi);
    registerGoalCommand(pi);
    const ctx: any = { cwd, hasUI: true, isIdle: () => true, hasPendingMessages: () => false,
      sessionManager: { getBranch: () => entries, getSessionId: () => 'session-1' },
      ui: { select: async () => 'Start in Edits', notify() {} } };
    for (const fn of handlers.get('session_start') ?? []) await fn({ reason: 'new' }, ctx);
    shortcut(); shortcut();
    entries.push({ type: 'custom', customType: 'bi.goal-state', data: { version: 1, objective: 'Finish', status: 'active', progress: 'Plan prepared', iteration: 0, reportCount: 1, maxIterations: 8, createdAt: 1, updatedAt: 1 } });
    await tools.get('plan_note').execute('p', { content: 'Plan' }, undefined, undefined, ctx);
    let drafts: any[] = [], continuation = false;
    for (const fn of handlers.get('agent_before_settle') ?? []) {
      const result = await fn({ outcome: 'completed', entries: drafts, continue: continuation, context: { pendingMessages: [] } }, ctx);
      drafts = result?.entries ?? drafts; continuation = result?.continue ?? continuation;
    }
    assert.equal(mode.mode, 'acceptEdits');
    assert.equal(continuation, true);
    assert.equal(kickoff, 0);
    assert.equal(drafts.filter(entry => entry.customType === 'bi.goal-continuation').length, 1);
    assert.equal(drafts.find(entry => entry.customType === 'bi.permission-mode')?.data.mode, 'acceptEdits');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('No prompts and noninteractive contexts decline the underlying tool confirmations', async () => {
  const { registerTools } = await import('../src/extension/register-tools.ts');
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'bi-confirm-'));
  try {
    await writeFile(path.join(cwd, 'file'), 'unchanged');
    const defs = new Map<string, any>();
    let mode = 'dontAsk', prompts = 0;
    registerTools({ registerTool: (definition: any) => defs.set(definition.name, definition) } as any, { get mode() { return mode; } } as any);
    const ctx: any = { cwd, hasUI: true, sessionManager: { getSessionId: () => 'id' }, ui: { confirm: async () => { prompts++; return true; } } };
    const deleted = await defs.get('delete').execute('1', { path: 'file' }, undefined, undefined, ctx);
    const command = await defs.get('bash').execute('2', { command: 'pwd' }, undefined, undefined, ctx);
    assert.equal(deleted.isError, true); assert.equal(command.isError, true); assert.equal(prompts, 0);
    assert.equal(await readFile(path.join(cwd, 'file'), 'utf8'), 'unchanged');
    mode = 'default'; ctx.hasUI = false;
    assert.equal((await defs.get('bash').execute('3', { command: 'pwd' }, undefined, undefined, ctx)).isError, true);
    assert.equal(prompts, 0);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('Auto reviewer decisions are bounded and repeated declines switch to Manual', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'bi-review-'));
  try {
    let calls = 0;
    const h = host(undefined, { reviewer: async (summary: unknown) => { calls++; assert.deepEqual(summary, { tool: 'bash', operation: 'pwd' }); return 'deny'; } });
    const ctx = context(cwd);
    await h.emit('session_start', {}, ctx);
    h.shortcut(); h.shortcut(); h.shortcut();
    await h.emit('agent_start', {}, ctx);
    for (let i = 0; i < 3; i++) assert.equal((await h.emit('tool_call', { toolName: 'bash', input: { command: 'pwd' } }, ctx)).block, true);
    assert.equal(calls, 3); assert.equal(h.controller.mode, 'default');
    assert.equal(decidePermission('acceptEdits', 'write', { path: 'src/a.ts', content: '' }, cwd, { ask: ['write:src/*'] }).source, 'rule');
    assert.equal(decidePermission('acceptEdits', 'write', { path: 'src/a.ts', content: '' }, cwd, { deny: ['write:src/*.ts'] }).action, 'deny');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('confirmed Bypass can restore only with its launch flag; Auto counts declines across turns', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'bi-restricted-'));
  try {
    const ctx = context(cwd); ctx.ui.confirm = async () => true;
    const bypass = host('bypassPermissions');
    await bypass.emit('session_start', {}, ctx);
    assert.equal(bypass.controller.mode, 'bypassPermissions');
    assert.equal(await bypass.emit('tool_call', { toolName: 'write', input: { path: 'file', content: 'ok' } }, ctx), undefined);
    assert.equal((await bypass.emit('tool_call', { toolName: 'write', input: { path: '.env', content: 'no' } }, ctx)).block, true);
    const h = host(undefined, { reviewer: async () => 'deny' });
    await h.emit('session_start', {}, ctx); h.shortcut(); h.shortcut(); h.shortcut();
    for (let i = 0; i < 20; i++) {
      await h.emit('turn_start', {}, ctx);
      await h.emit('tool_call', { toolName: 'bash', input: { command: 'pwd' } }, ctx);
      if (i < 19) assert.equal(h.controller.mode, 'auto');
    }
    assert.equal(h.controller.mode, 'default');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('branch changes restore the saved mode and explicit asks override session approvals', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'bi-branch-'));
  try {
    const h = host(), ctx = context(cwd, 'Allow exact call for session');
    let prompts = 0;
    ctx.ui.select = async () => { prompts++; return 'Allow exact call for session'; };
    await h.emit('session_start', {}, ctx);
    const call = { toolName: 'write', input: { path: 'file', content: 'data' } };
    assert.equal(await h.emit('tool_call', call, ctx), undefined);
    assert.equal(await h.emit('tool_call', call, ctx), undefined);
    assert.equal(prompts, 1);
    await mkdir(path.join(cwd, '.pi'));
    await writeFile(path.join(cwd, '.pi', 'permission-modes.json'), JSON.stringify({ ask: ['write:file'] }));
    assert.equal((await h.emit('tool_call', call, ctx)).block, true);
    assert.equal(prompts, 2);
    ctx.branch.push({ type: 'custom', customType: 'bi.permission-mode', data: { mode: 'plan' } });
    await h.emit('session_tree', {}, ctx);
    assert.equal(h.controller.mode, 'plan');
    assert.equal((await h.emit('tool_call', call, ctx)).block, true);
    ctx.branch.push({ type: 'custom', customType: 'bi.permission-mode', data: { mode: 'acceptEdits' } });
    await h.emit('session_tree', {}, ctx);
    assert.equal(h.controller.mode, 'acceptEdits');
    assert.equal((await h.emit('tool_call', call, ctx)).block, true);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
