import assert from 'node:assert/strict';
import test from 'node:test';
import { registerGoalCommand } from '../../src/commands/goal/index.ts';
import { GOAL_STATE_ENTRY, readGoalState } from '../../src/commands/goal/state.ts';

function createHarness() {
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const events = new Map<string, (event: any, ctx: any) => any>();
  const tools = new Map<string, any>();
  const entries: any[] = [];
  const prompts: string[] = [];
  const notifications: string[] = [];
  const pi = {
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: (name: string, handler: (event: any, ctx: any) => any) => events.set(name, handler),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: 'custom', customType, data }),
    sendUserMessage: (message: string) => prompts.push(message),
  };
  const ctx = {
    cwd: '/project',
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: { getBranch: () => entries },
    ui: { notify: (message: string) => notifications.push(message) },
  };
  registerGoalCommand(pi as any);

  return { commands, events, tools, entries, prompts, notifications, ctx };
}

function persistBoundaryDrafts(harness: ReturnType<typeof createHarness>, result: any) {
  for (const entry of result?.entries ?? []) {
    if (entry.type === 'custom') harness.entries.push(entry);
  }
}

test('/goal starts a persisted goal and reports progress with the tool', async () => {
  const harness = createHarness();
  await harness.commands.get('goal')!.handler('Build a login page', harness.ctx);
  let goal = readGoalState(harness.entries);
  assert.equal(goal?.objective, 'Build a login page');
  assert.equal(goal?.status, 'active');
  assert.equal(goal?.maxIterations, 8);
  assert.match(harness.prompts[0], /acceptance criteria/);
  assert.match(harness.prompts[0], /goal_report tool exactly once/);
  assert.match(harness.prompts[0], /one focused clarifying question/);

  const reportTool = harness.tools.get('goal_report');
  const result = await reportTool.execute('call-1', {
    status: 'continue',
    summary: 'Implemented the form; API integration and tests remain.',
  }, undefined, undefined, harness.ctx);
  assert.match(result.content[0].text, /progress saved/);
  goal = readGoalState(harness.entries);
  assert.equal(goal?.progress, 'Implemented the form; API integration and tests remain.');
  assert.equal(goal?.status, 'active');
  assert.equal(goal?.reportCount, 1);

  const boundary = harness.events.get('agent_before_settle')!;
  const continuation = await boundary({ outcome: 'completed', entries: [], context: { pendingMessages: [] } }, harness.ctx);
  assert.equal(continuation.continue, true);
  persistBoundaryDrafts(harness, continuation);
  assert.equal(readGoalState(harness.entries)?.reportCount, 0);
  assert.equal(readGoalState(harness.entries)?.iteration, 1);

  await reportTool.execute('call-2', {
    status: 'completed',
    summary: 'Added the page and verified npm test passes.',
  }, undefined, undefined, harness.ctx);
  assert.equal(readGoalState(harness.entries)?.status, 'completed');
  const settled = await boundary({ outcome: 'completed', entries: [], context: { pendingMessages: [] } }, harness.ctx);
  assert.equal(settled, undefined);
});

test('/goal controls pause, resume, clear, and iteration budget', async () => {
  const harness = createHarness();
  const command = harness.commands.get('goal')!.handler;
  await command('Build a login page', harness.ctx);
  await command('pause', harness.ctx);
  assert.equal(readGoalState(harness.entries)?.status, 'paused');

  await command('resume', harness.ctx);
  assert.equal(readGoalState(harness.entries)?.status, 'active');
  assert.equal(harness.prompts.length, 2);
  await command('edit Add login and registration pages', harness.ctx);
  assert.equal(readGoalState(harness.entries)?.objective, 'Add login and registration pages');

  await command('budget 1', harness.ctx);
  assert.equal(readGoalState(harness.entries)?.maxIterations, 1);
  const reportTool = harness.tools.get('goal_report');
  await reportTool.execute('call-budget-1', {
    status: 'continue', summary: 'Updated the login page; more work remains.',
  }, undefined, undefined, harness.ctx);
  const boundary = harness.events.get('agent_before_settle')!;
  const first = await boundary({ outcome: 'completed', entries: [], context: { pendingMessages: [] } }, harness.ctx);
  assert.equal(first.continue, true);
  persistBoundaryDrafts(harness, first);
  assert.equal(readGoalState(harness.entries)?.iteration, 1);
  await reportTool.execute('call-budget-2', {
    status: 'continue', summary: 'Finished one continuation; budget is now reached.',
  }, undefined, undefined, harness.ctx);

  const exhausted = await boundary({ outcome: 'completed', entries: [], context: { pendingMessages: [] } }, harness.ctx);
  assert.equal(exhausted.continue, undefined);
  persistBoundaryDrafts(harness, exhausted);
  assert.equal(readGoalState(harness.entries)?.status, 'budget_exceeded');

  await command('resume', harness.ctx);
  assert.equal(readGoalState(harness.entries)?.status, 'active');
  assert.equal(readGoalState(harness.entries)?.iteration, 0);
  assert.equal(readGoalState(harness.entries)?.maxIterations, 1);

  await command('clear', harness.ctx);
  assert.equal(readGoalState(harness.entries), undefined);
  assert.equal(harness.entries.at(-1).customType, GOAL_STATE_ENTRY);
  assert.equal(harness.entries.at(-1).data, null);
});

test('goal continuation pauses for queued input and persists agent interruption', async () => {
  const harness = createHarness();
  await harness.commands.get('goal')!.handler('Improve error handling', harness.ctx);
  await harness.tools.get('goal_report').execute('call-pending', {
    status: 'continue', summary: 'Made progress while a queued message arrived.',
  }, undefined, undefined, harness.ctx);
  const boundary = harness.events.get('agent_before_settle')!;
  const waiting = await boundary({
    outcome: 'completed', entries: [], context: { pendingMessages: [{ role: 'user' }] },
  }, harness.ctx);
  assert.equal(waiting.continue, undefined);
  persistBoundaryDrafts(harness, waiting);
  assert.equal(readGoalState(harness.entries)?.status, 'active');
  assert.equal(readGoalState(harness.entries)?.reportCount, 0);

  await harness.events.get('agent_settled')!({ aborted: true }, harness.ctx);
  assert.equal(readGoalState(harness.entries)?.status, 'paused');
  assert.match(harness.notifications.at(-1)!, /paused after interruption/);
});

test('goal continuation blocks a turn that omits its progress report', async () => {
  const harness = createHarness();
  await harness.commands.get('goal')!.handler('Add error handling', harness.ctx);
  const boundary = harness.events.get('agent_before_settle')!;
  const result = await boundary({ outcome: 'completed', entries: [], context: { pendingMessages: [] } }, harness.ctx);
  persistBoundaryDrafts(harness, result);
  const goal = readGoalState(harness.entries);
  assert.equal(goal?.status, 'blocked');
  assert.match(goal?.progress ?? '', /without exactly one goal_report/);
});

test('duplicate progress reports block the active goal', async () => {
  const harness = createHarness();
  await harness.commands.get('goal')!.handler('Improve error handling', harness.ctx);
  const tool = harness.tools.get('goal_report');
  await tool.execute('call-first', { status: 'continue', summary: 'Implemented retry handling.' }, undefined, undefined, harness.ctx);
  const duplicate = await tool.execute('call-second', { status: 'continue', summary: 'Duplicate report.' }, undefined, undefined, harness.ctx);
  assert.equal(duplicate.isError, true);
  assert.equal(readGoalState(harness.entries)?.status, 'blocked');
});

test('goal continuation stops on errors and resumes active saved goals', async () => {
  const harness = createHarness();
  await harness.commands.get('goal')!.handler('Fix the failing test', harness.ctx);
  const boundary = harness.events.get('agent_before_settle')!;
  const failed = await boundary({ outcome: 'error', entries: [], context: { pendingMessages: [] } }, harness.ctx);
  persistBoundaryDrafts(harness, failed);
  assert.equal(readGoalState(harness.entries)?.status, 'blocked');

  // A saved active goal is resumed on session startup/resume, but not on reload.
  await harness.commands.get('goal')!.handler('Fix a different test', harness.ctx);
  await harness.tools.get('goal_report').execute('call-recovery', {
    status: 'continue', summary: 'The previous turn completed before restart.',
  }, undefined, undefined, harness.ctx);
  harness.prompts.length = 0;
  await harness.events.get('session_start')!({ reason: 'reload' }, harness.ctx);
  assert.equal(harness.prompts.length, 0);
  assert.equal(readGoalState(harness.entries)?.reportCount, 0);
  assert.equal(readGoalState(harness.entries)?.iteration, 1);
  await harness.events.get('session_start')!({ reason: 'resume' }, harness.ctx);
  assert.equal(harness.prompts.length, 1);
  assert.match(harness.prompts[0], /Fix a different test/);
  await harness.events.get('session_start')!({ reason: 'fork' }, harness.ctx);
  assert.equal(harness.prompts.length, 2);
});

test('goal report tool refuses empty and inactive reports', async () => {
  const harness = createHarness();
  const tool = harness.tools.get('goal_report');
  const inactive = await tool.execute('call-1', { status: 'completed', summary: 'done' }, undefined, undefined, harness.ctx);
  assert.equal(inactive.isError, true);

  await harness.commands.get('goal')!.handler('Add tests', harness.ctx);
  const empty = await tool.execute('call-2', { status: 'continue', summary: '   ' }, undefined, undefined, harness.ctx);
  assert.equal(empty.isError, true);
  assert.equal(readGoalState(harness.entries)?.progress, '');
});
