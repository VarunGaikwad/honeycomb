import assert from 'node:assert/strict';
import test from 'node:test';
import { registerVerifyCommand } from '../../src/commands/verify.ts';

test('/verify refuses busy or queued input and plans without execution in Plan mode', async () => {
  let handler!: (args: string, ctx: any) => Promise<void>;
  const messages: string[] = [], notices: string[] = [];
  registerVerifyCommand({ registerCommand: (_: string, command: any) => { handler = command.handler; }, sendUserMessage: (text: string) => messages.push(text) } as never, { mode: 'plan' } as never);
  const ctx = { isIdle: () => false, hasPendingMessages: () => false, ui: { notify: (text: string) => notices.push(text) } };
  await handler('', ctx);
  ctx.isIdle = () => true;
  ctx.hasPendingMessages = () => true;
  await handler('', ctx);
  assert.equal(messages.length, 0);
  assert.equal(notices.length, 2);
  ctx.hasPendingMessages = () => false;
  await handler('tests', ctx);
  assert.match(messages[0]!, /propose checks only/);
  assert.match(messages[0]!, /User focus: tests/);
});
