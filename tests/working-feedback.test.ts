import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerWorkingFeedback } from '../src/tui/working-feedback.ts';

test('working feedback tracks tools, delays tips, and clears on reply or shutdown', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const handlers = new Map<string, Function>();
  let label: string | undefined;
  let widget: any;
  const ctx = { mode: 'tui', ui: {
    setWorkingMessage: (value?: string) => { label = value; },
    setWidget: (_key: string, value: unknown) => { widget = value; },
  } };
  registerWorkingFeedback({ on: (name: string, cb: Function) => handlers.set(name, cb) } as any,
    { enabled: true, delayMs: 20 });
  const emit = (name: string, event = {}) => handlers.get(name)!(event, ctx);
  emit('agent_start');
  emit('tool_execution_start', { toolCallId: '1', toolName: 'read' });
  emit('tool_execution_start', { toolCallId: '2', toolName: 'bash' });
  assert.match(label!, /^Running tools/);
  emit('tool_execution_end', { toolCallId: '2' });
  assert.match(label!, /^Reading files/);
  t.mock.timers.tick(19);
  assert.equal(widget, undefined);
  emit('ui_prompt_start');
  t.mock.timers.tick(20);
  assert.equal(widget, undefined);
  emit('ui_prompt_end');
  t.mock.timers.tick(20);
  const render = widget({}, { fg: (_color: string, text: string) => text }).render;
  assert.match(render(80)[0], /Tip: Use \/tasks/);
  assert.deepEqual(render(12), []);
  emit('tool_execution_end', { toolCallId: '1' });
  emit('message_update', { assistantMessageEvent: { type: 'text_delta' } });
  assert.match(label!, /^Writing reply/);
  assert.equal(widget, undefined);
  emit('agent_settled', { aborted: true });
  assert.equal(label, undefined);
  emit('agent_start');
  emit('session_shutdown');
  t.mock.timers.tick(20);
  assert.equal(widget, undefined);
});
