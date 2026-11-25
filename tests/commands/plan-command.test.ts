import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerPlanCommand } from '../../src/commands/plan.ts';

test('/plan enters before requesting a turn and refuses busy or restricted modes', async () => {
  let handler!: (args: string, ctx: any) => Promise<void>;
  let mode = 'default';
  const messages: string[] = [];
  const permissions = { get mode() { return mode; }, enterPlan() { if (mode === 'dontAsk') return false; mode = 'plan'; return true; } };
  registerPlanCommand({ registerCommand: (_: string, command: any) => { handler = command.handler; }, sendUserMessage: (text: string) => { assert.equal(mode, 'plan'); messages.push(text); } } as never, permissions as never);
  const ctx = { mode: 'tui', hasUI: true, isIdle: () => true, hasPendingMessages: () => false, ui: { notify() {} } };
  await handler('', ctx);
  assert.equal(mode, 'plan');
  assert.equal(messages.length, 0);
  mode = 'dontAsk';
  await handler('request', ctx);
  assert.equal(messages.length, 0);
  mode = 'default';
  ctx.hasPendingMessages = () => true;
  await handler('request', ctx);
  assert.equal(mode, 'default');
  ctx.hasPendingMessages = () => false;
  await handler('request', ctx);
  assert.equal(messages.length, 1);
});

test('/plan show refuses non-TUI use and invalid permission rules', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'bi-plan-command-'));
  try {
    let handler!: (args: string, ctx: any) => Promise<void>;
    const notices: string[] = [];
    registerPlanCommand({ registerCommand: (_: string, command: any) => { handler = command.handler; }, sendUserMessage: () => { throw new Error('unexpected model request'); } } as never, { mode: 'plan', enterPlan: () => { throw new Error('unexpected transition'); } } as never);
    const ctx = { cwd, mode: 'rpc', hasUI: true, isIdle: () => true, hasPendingMessages: () => false, ui: { notify: (text: string) => notices.push(text) } };
    await handler('show', ctx);
    assert.equal(notices.length, 0);
    await mkdir(join(cwd, '.pi'));
    await writeFile(join(cwd, '.pi', 'permission-modes.json'), 'invalid');
    ctx.mode = 'tui';
    Object.assign(ctx, { sessionManager: { getSessionId: () => 'session', getLeafId: () => 'leaf' } });
    await handler('show', ctx);
    assert.match(notices[0]!, /permission rules/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
