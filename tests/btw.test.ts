import assert from 'node:assert/strict';
import test from 'node:test';
import { registerBtwCommand } from '../src/commands/btw.ts';

for (const action of ['deny', 'answer', 'cancel', 'timeout'] as const) {
  test(`/btw: ${action} does not modify the main session`, async () => {
    let handler!: (args: string, ctx: unknown) => Promise<void>;
    let requests = 0;
    let rendered = '';
    registerBtwCommand({
      on() {},
      registerCommand(_name: string, command: { handler: typeof handler }) { handler = command.handler; },
      appendEntry() { assert.fail('must not write transcript'); },
      sendUserMessage() { assert.fail('must not change main context'); },
    } as never, { mode: 'default', prompter: { confirm: async () => action !== 'deny' } } as never, action === 'timeout' ? 1 : 30_000);
    await handler('side question', {
      mode: 'tui', hasUI: true, isIdle: () => true, hasPendingMessages: () => false,
      model: { provider: 'mock', id: 'test' },
      modelRegistry: { streamSimple(_model: unknown, context: any, options: { signal: AbortSignal }) {
        requests++;
        assert.deepEqual(context.tools, []);
        assert.deepEqual(context.messages.map((message: any) => message.content), ['side question']);
        return {
          async *[Symbol.asyncIterator]() {
            if (action === 'timeout') {
              await new Promise<void>(resolve => options.signal.addEventListener('abort', () => resolve(), { once: true }));
              return;
            }
            yield { type: 'text_delta', delta: 'isolated answer' };
          },
          async result() { return { usage: { totalTokens: 10 }, stopReason: 'stop' }; },
        };
      } },
      ui: { custom: (factory: Function) => new Promise(done => {
        const component = factory({ terminal: { rows: 24 }, requestRender() {
          rendered = component.render(120).join('\n');
          if (rendered.includes('10 tokens') || rendered.includes('Request timed out.')) component.handleInput('cancel');
        } }, { fg: (_color: string, text: string) => text }, { matches: (key: string, binding: string) => key === 'cancel' && binding === 'tui.select.cancel' }, done);
        if (action === 'cancel') component.handleInput('cancel');
      }) },
    });
    assert.equal(requests, action === 'answer' || action === 'timeout' ? 1 : 0);
    if (action === 'answer') assert.match(rendered, /isolated answer/);
  });
}
