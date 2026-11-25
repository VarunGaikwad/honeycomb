import assert from 'node:assert/strict';
import test from 'node:test';
import { registerSecurityReviewCommand } from '../src/commands/security-review.ts';

test('/security-review requires explicit scope and does not start a model turn', async () => {
  let handler!: (args: string, ctx: any) => Promise<void>;
  const notices: string[] = [];
  registerSecurityReviewCommand({ on() {}, registerCommand: (_: string, command: any) => { handler = command.handler; }, sendUserMessage: () => { throw new Error('unexpected turn'); } } as never, { mode: 'default' } as never);
  const ctx = { mode: 'tui', hasUI: true, ui: { notify: (text: string) => notices.push(text) } };
  await handler('', ctx);
  await handler('other', ctx);
  assert.equal(notices.length, 2);
  assert.match(notices[0]!, /staged\|unstaged/);
});
