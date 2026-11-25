import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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

test('working tips suggest LSP setup only when no supported server is found', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'bi-lsp-tip-'));
  const cwd = path.join(base, 'workspace');
  await mkdir(cwd);
  const previousPath = process.env.PATH;
  const previousHome = process.env.HOME;
  t.after(async () => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(base, { recursive: true, force: true });
  });
  process.env.PATH = base;
  process.env.HOME = base;
  const collect = async (configured?: string) => {
    const handlers = new Map<string, Function>();
    registerWorkingFeedback({ on: (name: string, cb: Function) => handlers.set(name, cb),
      getAllTools: () => [{ name: 'lsp' }], getFlag: () => configured } as any, { enabled: true, delayMs: 40 });
    const shown: string[] = [];
    for (let i = 0; i < 4; i++) {
      shown.push(await new Promise<string>(resolve => {
        const ctx = { cwd, mode: 'tui', ui: {
          setWorkingMessage() {},
          setWidget(_key: string, widget: any) {
            if (widget) resolve(widget({}, { fg: (_color: string, text: string) => text }).render(130)[0]);
          },
        } };
        handlers.get('agent_start')!({}, ctx);
        // The widget timer is unref'd; keep this fixture alive until the tip fires.
        const keepAlive = setTimeout(() => resolve(''), 500);
        t.after(() => clearTimeout(keepAlive));
      }));
      handlers.get('agent_settled')!();
    }
    return shown;
  };
  assert.match((await collect())[3]!, /Use \/lsp/);
  const configured = path.join(base, 'custom-server');
  await writeFile(configured, '', { mode: 0o700 });
  assert.doesNotMatch((await collect(configured)).join('\n'), /Use \/lsp/);
  await writeFile(path.join(base, 'typescript-language-server'), '', { mode: 0o700 });
  assert.doesNotMatch((await collect()).join('\n'), /Use \/lsp/);
});
