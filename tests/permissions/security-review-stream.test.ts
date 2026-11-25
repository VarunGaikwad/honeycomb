import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { registerSecurityReviewCommand } from '../../src/commands/security-review.ts';

test('security review sends no tools and ignores unexpected tool blocks', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'bi-security-stream-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd });
    await writeFile(join(cwd, 'a.txt'), 'test\n');
    execFileSync('git', ['add', 'a.txt'], { cwd });
    let handler!: (args: string, ctx: any) => Promise<void>, requests = 0, requestSignal: AbortSignal | undefined;
    registerSecurityReviewCommand({ on() {}, registerCommand: (_: string, command: any) => { handler = command.handler; }, sendUserMessage: () => { throw new Error('unexpected agent turn'); } } as never, { mode: 'default', prompter: { confirm: async () => true } } as never);
    const model = { provider: 'test', id: 'test' };
    const ctx = { cwd, mode: 'tui', hasUI: true, model, isIdle: () => true, hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => 'session', getLeafId: () => 'leaf' },
      modelRegistry: { streamSimple: (_model: unknown, input: any, options: any) => {
        requestSignal = options.signal;
        requests++; assert.deepEqual(input.tools, []); assert.match(input.messages[0].content, /test/);
        return { async *[Symbol.asyncIterator]() { yield { type: 'toolcall_end', toolCall: { name: 'bash', arguments: { command: 'danger' } } }; }, result: async () => ({ stopReason: 'toolUse' }) };
      } },
      ui: { notify() {}, custom: async (factory: any) => { let close!: () => void; const closed = new Promise<void>(resolve => { close = resolve; }); const component = factory({ requestRender() {}, terminal: { rows: 24 } }, { fg: (_: unknown, text: string) => text }, { matches: (data: string, key: string) => data === 'esc' && key === 'tui.select.cancel' }, close); await new Promise(resolve => setTimeout(resolve, 50)); component.handleInput('esc'); await closed; } },
    };
    await handler('staged', ctx);
    assert.equal(requests, 1);
    assert.equal(requestSignal?.aborted, true, 'closing the review cancels its request');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
