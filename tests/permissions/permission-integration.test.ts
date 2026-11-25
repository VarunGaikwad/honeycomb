import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { link, mkdtemp, readFile, rename, rm, symlink, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPermissionModes, type PermissionMode } from '../../src/extension/permission-modes/index.ts';
import { decidePermission } from '../../src/extension/permission-modes/policy.ts';
import { planNotePath, writePlanNote } from '../../src/extension/permission-modes/plan-note.ts';
import { installTui } from '../../src/tui/index.ts';

test('permission rules apply to resolved destinations and protect their configuration', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'bi-rule-safety-'));
  try {
    await mkdir(path.join(cwd, 'docs'));
    await mkdir(path.join(cwd, 'src'));
    await symlink('../src', path.join(cwd, 'docs', 'alias'));
    const rules = { allow: ['write:docs/*'], deny: ['git_diff:*'] };
    assert.equal(decidePermission('default', 'write', { path: 'docs/guide', content: '' }, cwd, rules).action, 'allow');
    assert.equal(decidePermission('default', 'write', { path: 'docs/../src/file', content: '' }, cwd, rules).action, 'ask');
    assert.equal(decidePermission('default', 'write', { path: 'docs/alias/file', content: '' }, cwd, rules).action, 'ask');
    assert.equal(decidePermission('acceptEdits', 'write', { path: '.pi/permission-modes.json', content: '{}' }, cwd).action, 'deny');
    assert.equal(decidePermission('bypassPermissions', 'git_diff', {}, cwd, rules).action, 'deny');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('writing a plan note does not modify an existing hard-linked file', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'bi-plan-link-'));
  try {
    const original = path.join(cwd, 'original');
    await writeFile(original, 'original content');
    await mkdir(path.join(cwd, '.pi', 'plans'), { recursive: true });
    await link(original, planNotePath(cwd, 'session-1'));
    await writePlanNote(cwd, 'session-1', 'new plan');
    assert.equal(await readFile(original, 'utf8'), 'original content');
    assert.equal(await readFile(planNotePath(cwd, 'session-1'), 'utf8'), 'new plan');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('a symlink at the allow rule prefix cannot move the allowed scope', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'bi-allow-prefix-'));
  try {
    await mkdir(path.join(cwd, 'src'));
    await symlink('src', path.join(cwd, 'docs'));
    for (const pattern of ['docs/*', './docs/*', path.join(cwd, 'docs/*')]) {
      const rules = { allow: [`write:${pattern}`] };
      for (const target of ['docs/file', 'src/file']) {
        assert.equal(decidePermission('default', 'write', { path: target, content: '' }, cwd, rules).action, 'ask');
      }
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('the Pi tool gate rejects linked project permission rules', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'bi-linked-rules-'));
  try {
    const h = host();
    const ctx = context(cwd);
    await h.emit('session_start', {}, ctx);
    h.shortcut();
    const ordinaryWrite = { toolName: 'write', input: { path: 'target.json', content: '{}' } };
    assert.equal(await h.emit('tool_call', ordinaryWrite, ctx), undefined);
    await mkdir(path.join(cwd, '.pi'));
    const config = path.join(cwd, '.pi', 'permission-modes.json');
    const target = path.join(cwd, 'target.json');
    await writeFile(target, '{"deny":["read:*"]}');
    for (const makeLink of [() => symlink(target, config), () => symlink('missing.json', config), () => link(target, config)]) {
      await makeLink();
      assert.match((await h.emit('tool_call', ordinaryWrite, ctx)).reason, /Invalid permission configuration/);
      await rm(config);
    }
    await writeFile(config, '{"deny":["read:*"]}');
    assert.equal((await h.emit('tool_call', { toolName: 'read', input: { path: 'target.json' } }, ctx)).block, true);
    await rename(path.join(cwd, '.pi'), path.join(cwd, 'settings'));
    await symlink('settings', path.join(cwd, '.pi'));
    assert.match((await h.emit('tool_call', ordinaryWrite, ctx)).reason, /Invalid permission configuration/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

function host(flag?: string, reviewer?: any) {
  const events = new Map<string, any[]>(), entries: any[] = [];
  const tools = new Map<string, any>();
  let shortcut: any, tool: any, active = ['read', 'write', 'bash', 'goal_report'];
  const pi: any = {
    registerFlag() {}, getFlag() { return flag; },
    registerShortcut(_key: string, opts: any) { shortcut = opts.handler; },
    registerTool(definition: any) { tool = definition; tools.set(definition.name, definition); },
    on(name: string, handler: any) { events.set(name, [...(events.get(name) ?? []), handler]); },
    appendEntry(customType: string, data: unknown) { entries.push({ type: 'custom', customType, data }); },
    getActiveTools() { return [...active]; }, setActiveTools(names: string[]) { active = [...names]; },
  };
  const controller = createPermissionModes(pi, reviewer);
  const emit = async (name: string, event: any, ctx: any) => { let output: any; for (const handler of events.get(name) ?? []) output = await handler(event, ctx); return output; };
  return { pi, tools, controller, emit, entries, shortcut: () => shortcut(), get tool() { return tool; }, get active() { return active; } };
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
    assert.equal(decidePermission('acceptEdits', 'apply_patch', { edits: [{ path: 'file', oldText: 'a', newText: 'b' }, { path: '../outside', oldText: 'a', newText: 'b' }] }, cwd).action, 'deny');
    assert.equal(decidePermission('bypassPermissions', 'write', { path: 'file', content: '' }, cwd, { ask: ['write:*'] }).action, 'ask');
    assert.equal(decidePermission('dontAsk', 'read', { path: '.env' }, cwd).action, 'deny');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('workspace escapes and protected shell redirects are blocked without opening an approval prompt', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bi-deny-before-prompt-'));
  try {
    const cwd = path.join(root, 'project');
    const other = path.join(root, 'other');
    await mkdir(cwd); await mkdir(other); await mkdir(path.join(cwd, '.pi'));
    await symlink(other, path.join(cwd, 'escape'));
    await writeFile(path.join(cwd, '.pi', 'permission-modes.json'), JSON.stringify({ ask: ['ls:*', 'glob:*', 'lsp:*'], deny: ['read:private.ts'] }));
    const h = host(), ctx = context(cwd);
    let prompts = 0;
    ctx.ui.select = async () => { prompts++; return 'Allow once'; };
    await h.emit('session_start', {}, ctx);
    const blocked = [
      ['ls', { path: other }, /outside the working directory/],
      ['ls', { path: 'escape' }, /outside the working directory/],
      ['ls', { path: null }, /Invalid path/],
      ['copy', { source: '../other/file', destination: 'file' }, /outside the working directory/],
      ['write', { path: 'escape/new-file', content: 'data' }, /outside the working directory/],
      ['glob', { path: '.git', pattern: '*' }, /non-protected workspace path/],
      ['lsp', { action: 'hover', path: 'private.ts', language_id: 'typescript', line: 0, character: 0 }, /restricted by read policy/],
      ['bash', { command: 'ls -d "$HOME"/.bi-lsp/ typescript-language-server 2>/dev/null; grep -n cwd src/tools/lsp-client.ts' }, /protected output destination/],
    ] as const;
    for (const [toolName, input, reason] of blocked) {
      const result = await h.emit('tool_call', { toolName, input, toolCallId: `blocked-${toolName}` }, ctx);
      assert.equal(result?.block, true, toolName);
      assert.match(result.reason, reason, toolName);
    }
    assert.equal(prompts, 0);
    assert.equal(await h.emit('tool_call', { toolName: 'ls', input: {}, toolCallId: 'ordinary-list' }, ctx), undefined);
    assert.equal(prompts, 1, 'an in-workspace list still honors the explicit Ask rule');
  } finally { await rm(root, { recursive: true, force: true }); }
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

test('reload prefers the latest mode and leaves plan_note inactive outside Plan', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'bi-reload-mode-'));
  try {
    const ctx = context(cwd), h = host('plan');
    await h.emit('session_start', { reason: 'startup' }, ctx);
    assert.equal(h.controller.mode, 'plan');
    await h.emit('session_shutdown', { reason: 'reload' }, ctx);
    assert.deepEqual(h.active, ['read', 'write', 'bash', 'goal_report']);
    ctx.branch.push({ type: 'custom', customType: 'bi.permission-mode', data: { mode: 'auto' } });
    const reloaded = host('plan');
    await reloaded.emit('session_start', { reason: 'reload' }, ctx);
    assert.equal(reloaded.controller.mode, 'auto');
    assert.ok(!reloaded.active.includes('plan_note'));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('footer redraws on mode change, retains a narrow label and unsubscribes', () => {
  let footer: any, notify: any, unsubscribed = false, renders = 0;
  let mode: PermissionMode = 'default';
  const controller = { get mode() { return mode; }, label: 'Manual', cycle() {}, subscribe(fn: () => void) { notify = fn; return () => { unsubscribed = true; }; } };
  const ctx: any = { cwd: process.cwd(), sessionManager: { getBranch: () => [] }, ui: { setHeader() {}, setFooter(factory: any) { footer = factory({ requestRender() { renders++; } }, { fg: (_: any, text: string) => text }, { onBranchChange: () => () => {}, getGitBranch: () => undefined }); } } };
  installTui(ctx, controller, 'compact');
  assert.match(footer.render(12)[0], /Manual/);
  assert.match(footer.render(80)[0], /^(?:⏸|\|\|) manual mode on\b/);
  controller.label = 'Plan'; mode = 'plan'; notify(); assert.equal(renders, 1);
  assert.match(footer.render(80)[0], /plan mode on/);
  footer.dispose(); assert.equal(unsubscribed, true);
});

test('plan approval composes with goal continuation without starting another turn', async () => {
  const { registerGoalCommand } = await import('../../src/commands/goal/index.ts');
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
  const { registerTools } = await import('../../src/extension/register-tools.ts');
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

test('git commit combines approvals and binds them to one exact call', async () => {
  const { registerTools } = await import('../../src/extension/register-tools.ts');
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'bi-commit-approval-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    git('config', 'user.name', 'Bi Test'); git('config', 'user.email', 'bi@example.test');
    git('config', 'commit.gpgsign', 'false');
    await writeFile(path.join(cwd, 'file'), 'staged');
    git('add', 'file');
    const h = host();
    registerTools(h.pi, h.controller);
    const ctx = context(cwd);
    const titles: string[] = [];
    let selected = 'Deny', extraConfirmations = 0;
    ctx.ui.select = async (title?: string) => { titles.push(title!); return selected; };
    ctx.ui.confirm = async () => { extraConfirmations++; return false; };
    await h.emit('session_start', {}, ctx);
    const input = { message: 'Record staged file' };
    const gate = (toolCallId: string) => h.emit('tool_call', { toolName: 'git_commit', toolCallId, input }, ctx);
    const execute = (id: string, args = input) => h.tools.get('git_commit').execute(id, args, undefined, undefined, ctx);
    assert.equal((await gate('declined')).block, true);
    assert.equal((await execute('declined')).isError, true);
    selected = 'Yes, commit once';
    assert.equal(await gate('call'), undefined);
    assert.equal((await execute('other')).isError, true);
    assert.equal((await execute('call')).isError, undefined);
    assert.equal((await execute('call')).isError, true);
    assert.equal(git('log', '-1', '--format=%s'), input.message);
    assert.deepEqual(titles, Array(2).fill(`Commit staged changes?\nPermission requires confirmation\n${input.message}`));
    selected = 'Allow once';
    for (const [toolName, args] of [
      ['git_add', { paths: ['file'] }],
      ['git_branch', { name: 'audit-branch' }],
      ['git_checkout', { branch: 'audit-branch' }],
    ] as const) {
      const toolCallId = `combined-${toolName}`;
      assert.equal(await h.emit('tool_call', { toolName, toolCallId, input: args }, ctx), undefined);
      assert.equal((await h.tools.get(toolName).execute(toolCallId, args, undefined, undefined, ctx)).isError, undefined);
    }
    await writeFile(path.join(cwd, 'delete-me'), 'temporary');
    const deletion = { path: 'delete-me' };
    assert.equal(await h.emit('tool_call', { toolName: 'delete', toolCallId: 'delete-once', input: deletion }, ctx), undefined);
    assert.equal((await h.tools.get('delete').execute('delete-once', deletion, undefined, undefined, ctx)).isError, undefined);
    await assert.rejects(readFile(path.join(cwd, 'delete-me')));
    for (const [toolName, args] of [
      ['bash', { command: 'pwd' }],
      ['run_code', { code: "console.log('ok')" }],
    ] as const) {
      const toolCallId = `combined-${toolName}`;
      assert.equal(await h.emit('tool_call', { toolName, toolCallId, input: args }, ctx), undefined);
      assert.equal((await h.tools.get(toolName).execute(toolCallId, args, undefined, undefined, ctx)).isError, undefined);
    }
    const collision = { command: 'pwd' };
    assert.equal(await h.emit('tool_call', { toolName: 'bash', toolCallId: 'collision', input: collision }, ctx), undefined);
    assert.equal((await h.tools.get('background').execute('collision', collision, undefined, undefined, ctx)).isError, true);
    const terminalArgs = { command: 'read -r line' };
    assert.equal(await h.emit('tool_call', { toolName: 'terminal', toolCallId: 'terminal-start', input: terminalArgs }, ctx), undefined);
    const terminal = await h.tools.get('terminal').execute('terminal-start', terminalArgs, undefined, undefined, ctx);
    assert.equal(terminal.isError, undefined);
    const terminalInput = { processId: terminal.details.metadata.processId, input: 'done\n' };
    assert.equal(await h.emit('tool_call', { toolName: 'terminal', toolCallId: 'terminal-input', input: terminalInput }, ctx), undefined);
    assert.equal((await h.tools.get('terminal').execute('terminal-input', terminalInput, undefined, undefined, ctx)).isError, undefined);
    const background = { command: 'true' };
    assert.equal(await h.emit('tool_call', { toolName: 'background', toolCallId: 'background-start', input: background }, ctx), undefined);
    assert.equal((await h.tools.get('background').execute('background-start', background, undefined, undefined, ctx)).isError, undefined);
    assert.equal(extraConfirmations, 0);
    selected = 'Yes, commit once';

    await writeFile(path.join(cwd, 'file'), 'new staged content');
    git('add', 'file');
    assert.equal(await gate('edited'), undefined);
    assert.equal((await execute('edited', { message: 'Different message' })).isError, true);
    assert.equal(await gate('mode-change'), undefined);
    h.shortcut();
    assert.equal((await execute('mode-change')).isError, true);
    assert.equal(await gate('rule-change'), undefined);
    await mkdir(path.join(cwd, '.pi'));
    await writeFile(path.join(cwd, '.pi', 'permission-modes.json'), '{"deny":["git_commit:*"]}');
    assert.equal((await execute('rule-change')).isError, true);
    const promptCount = titles.length;
    assert.equal((await gate('denied')).block, true);
    assert.equal(titles.length, promptCount);
    assert.equal(git('rev-list', '--count', 'HEAD'), '1');
    assert.equal(extraConfirmations, 0);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('Bi undo defers its gate prompt to the target-aware confirmation', async () => {
  const { registerTools } = await import('../../src/extension/register-tools.ts');
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'bi-undo-prompt-'));
  try {
    const h = host();
    h.pi.getAllTools = () => [{ name: 'undo', sourceInfo: { path: new URL('../../src/index.ts', import.meta.url).pathname } }];
    registerTools(h.pi, h.controller);
    const ctx = context(cwd);
    let gatePrompts = 0, confirmations = 0;
    ctx.ui.select = async () => { gatePrompts++; return 'Allow once'; };
    ctx.ui.confirm = async () => { confirmations++; return true; };
    await h.emit('session_start', {}, ctx);
    const write = { path: 'file', content: 'created' };
    await h.emit('tool_call', { toolName: 'write', toolCallId: 'write', input: write }, ctx);
    await h.tools.get('write').execute('write', write, undefined, undefined, ctx);
    gatePrompts = 0;
    assert.equal(await h.emit('tool_call', { toolName: 'undo', toolCallId: 'undo', input: {} }, ctx), undefined);
    assert.equal((await h.tools.get('undo').execute('undo', {}, undefined, undefined, ctx)).isError, undefined);
    assert.equal(gatePrompts, 0); assert.equal(confirmations, 1);
    await assert.rejects(readFile(path.join(cwd, 'file')));
    h.pi.getAllTools = () => [{ name: 'undo', sourceInfo: { path: '/other/extension.ts' } }];
    await h.emit('tool_call', { toolName: 'undo', toolCallId: 'external', input: {} }, ctx);
    assert.equal(gatePrompts, 1);
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

test('path rules cover normalized paths, symlink targets, and all patch paths', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'bi-rule-path-'));
  try {
    await mkdir(path.join(cwd, 'private'));
    await writeFile(path.join(cwd, 'private', 'data'), 'a');
    await symlink('private', path.join(cwd, 'alias'));
    const rules = { deny: ['read:private/*', 'apply_patch:private/*', 'copy:private/*'] };
    assert.equal(decidePermission('default', 'read', { path: './private/data' }, cwd, rules).action, 'deny');
    assert.equal(decidePermission('default', 'read', { path: 'alias/data' }, cwd, rules).action, 'deny');
    assert.equal(decidePermission('default', 'read', { path: 'private/data' }, cwd, { deny: ['read:alias/*'] }).action, 'deny');
    assert.equal(decidePermission('default', 'read', { path: 'private/data' }, cwd, { ask: ['read:alias/data'] }).action, 'ask');
    assert.equal(decidePermission('acceptEdits', 'copy', { source: 'alias/data', destination: 'other' }, cwd, rules).action, 'deny');
    assert.equal(decidePermission('acceptEdits', 'move', { source: 'other', destination: './private/data' }, cwd, { deny: ['move:private/*'] }).action, 'deny');
    assert.equal(decidePermission('acceptEdits', 'apply_patch', { edits: [{ path: 'other', oldText: 'a', newText: 'b' }, { path: 'alias/data', oldText: 'a', newText: 'b' }] }, cwd, rules).action, 'deny');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('approval fails closed if a rule, path, or mode changes while the prompt is open', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'bi-stale-approval-'));
  try {
    await mkdir(path.join(cwd, '.pi'));
    await symlink('first', path.join(cwd, 'file'));
    await writeFile(path.join(cwd, 'first'), 'one');
    await writeFile(path.join(cwd, 'second'), 'two');
    const ctx = context(cwd), h = host();
    await h.emit('session_start', {}, ctx);
    const call = { toolName: 'write', input: { path: 'file', content: 'edit' } };
    const ruleFile = path.join(cwd, '.pi', 'permission-modes.json');
    ctx.ui.select = async () => {
      await writeFile(ruleFile, JSON.stringify({ deny: ['write:file'] }));
      return 'Allow once';
    };
    assert.match((await h.emit('tool_call', call, ctx)).reason, /context changed/);
    await rm(ruleFile);
    ctx.ui.select = async () => {
      await rm(path.join(cwd, 'file'));
      await symlink('second', path.join(cwd, 'file'));
      return 'Allow exact call for session';
    };
    assert.match((await h.emit('tool_call', call, ctx)).reason, /context changed/);
    ctx.ui.select = async () => { h.controller.cycle(); return 'Allow once'; };
    assert.match((await h.emit('tool_call', call, ctx)).reason, /context changed/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('approving a plan refuses changed content', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'bi-stale-plan-'));
  try {
    const ctx = context(cwd), h = host('plan');
    await h.emit('session_start', {}, ctx);
    await h.tool.execute('1', { content: 'Original proposal' }, undefined, undefined, ctx);
    ctx.ui.select = async (title?: string) => {
      assert.match(title!, /Original proposal/);
      await writeFile(planNotePath(cwd, 'session-1'), 'Changed after preview');
      return 'Start in Edits';
    };
    assert.equal(await h.emit('agent_before_settle', { outcome: 'completed', entries: [] }, ctx), undefined);
    assert.equal(h.controller.mode, 'plan');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('standalone plan approval creates a single continuation', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'bi-plan-start-'));
  try {
    const h = host(), ctx = context(cwd, 'Start in Manual');
    await h.emit('session_start', {}, ctx); h.shortcut(); h.shortcut();
    await h.tool.execute('1', { content: 'Implement the fix' }, undefined, undefined, ctx);
    const result = await h.emit('agent_before_settle', { outcome: 'completed', entries: [], context: { pendingMessages: [] }, continue: false }, ctx);
    assert.equal(result.continue, true);
    assert.equal(result.entries.filter((entry: any) => entry.customType === 'bi.plan-approval').length, 1);
    assert.equal(h.controller.mode, 'default');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('remaining Plan choices do not start implementation', async () => {
  for (const choice of ['Keep planning', 'Discard the note', undefined]) {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'bi-plan-choice-'));
    try {
      const h = host(), ctx = context(cwd, choice);
      await h.emit('session_start', {}, ctx); h.shortcut(); h.shortcut();
      await h.tool.execute('1', { content: 'Plan' }, undefined, undefined, ctx);
      const result = await h.emit('agent_before_settle', { outcome: 'completed', entries: [], context: { pendingMessages: [] }, continue: false }, ctx);
      assert.equal(result, undefined);
      assert.equal(h.controller.mode, 'plan');
      if (choice === 'Discard the note') await assert.rejects(readFile(planNotePath(cwd, 'session-1')));
    } finally { await rm(cwd, { recursive: true, force: true }); }
  }
});

test('sensitive git diff requires confirmation before tool execution', async () => {
  const { execFileSync } = await import('node:child_process');
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'bi-diff-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  try {
    git('init'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
    await writeFile(path.join(cwd, '.env'), 'original');
    await writeFile(path.join(cwd, 'normal'), 'original');
    git('add', '.env', 'normal'); git('commit', '-m', 'initial');
    const { createGitTools } = await import('../../src/tools/git.ts');
    const diff = createGitTools().find(tool => tool.name === 'git_diff')!;
    let confirmations = 0;
    const ctx = { workingDirectory: cwd, sessionId: 'test', confirmSensitiveRead: async () => { confirmations++; return false; } };
    await writeFile(path.join(cwd, 'normal'), 'changed');
    assert.equal((await diff.execute({}, ctx)).success, true);
    assert.equal(confirmations, 0);
    await writeFile(path.join(cwd, '.env'), 'secret');
    const refused = await diff.execute({}, ctx);
    assert.equal(refused.success, false);
    assert.doesNotMatch(JSON.stringify(refused), /secret/);
    git('add', '.env');
    assert.equal((await diff.execute({ staged: true }, ctx)).success, false);
    assert.equal((await diff.execute({ staged: true }, { ...ctx, confirmSensitiveRead: async () => true })).success, true);
    assert.equal((await diff.execute({ staged: true }, { workingDirectory: cwd, sessionId: 'test' })).success, false);
    git('reset', '--hard', 'HEAD');
    git('mv', '.env', 'renamed');
    assert.equal((await diff.execute({ staged: true }, ctx)).success, false);
    git('reset', '--hard', 'HEAD');
    git('rm', '.env');
    assert.equal((await diff.execute({ staged: true }, ctx)).success, false);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
