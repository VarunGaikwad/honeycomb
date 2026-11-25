import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { matchesKey, visibleWidth, type Component, type KeyId } from '@earendil-works/pi-tui';
import { BiPromptEditor, installPromptEditor } from '../src/tui/editor.ts';
import { createWelcomeHeader, renderHeader } from '../src/tui/header.ts';
import { ASCII } from '../src/tui/text.ts';
import { createPermissionPrompter } from '../src/tui/permission-dialog.ts';
import { registerPermissionRules } from '../src/tui/permission-rules.ts';
import { toolPresentation } from '../src/tui/tool-renderer.ts';

const id = (text: string) => text;
const theme = { fg: (_color: string, text: string) => text, bold: id };
const selectKeys: Record<string, KeyId> = {
  'tui.select.up': 'up', 'tui.select.down': 'down',
  'tui.select.confirm': 'enter', 'tui.select.cancel': 'escape',
  'tui.select.pageUp': 'pageUp', 'tui.select.pageDown': 'pageDown', 'tui.input.tab': 'tab',
};
const keybindings = {
  matches: (data: string, action: string) => !!selectKeys[action] && matchesKey(data, selectKeys[action]!),
  getKeys: (action: string) => action === 'app.thinking.cycle' ? ['shift+tab'] : [],
};

function terminalDialog() {
  let component: (Component & { dispose?: () => void }) | undefined;
  let count = 0;
  let blocked: unknown;
  const ctx: any = {
    hasUI: true,
    mode: 'tui',
    isIdle: () => true,
    ui: {
      custom(factory: any, options: any) {
        return new Promise(resolve => {
          assert.equal(component, undefined, 'dialogs should not overlap');
          count++;
          blocked = options?.blocked;
          component = factory({ terminal: { rows: 20 }, requestRender() {} }, theme, keybindings, (value: unknown) => {
            component?.dispose?.();
            component = undefined;
            resolve(value);
          });
        });
      },
    },
  };
  return { ctx, get component() { return component!; }, get count() { return count; }, get blocked() { return blocked; } };
}

test('welcome panel adapts to narrow columns and escapes terminal controls in paths', () => {
  const cwd = '/project/スペース-\x1b[2J\nunsafe';
  for (const width of [1, 7, 24, 44, 69, 70, 80, 160]) {
    const lines = renderHeader(width, theme as any, cwd);
    assert.ok(lines.every(line => visibleWidth(line) <= width && !line.includes('\x1b[2J') && !line.includes('\n')));
    assert.equal(lines.some(line => line.includes('Welcome to Honeycomb!')), width >= 70);
  }
  assert.match(renderHeader(100, theme as any, cwd).join('\n'), /\\u001b\[2J\\nunsafe/);
  assert.match(renderHeader(100, theme as any, cwd).join('\n'), ASCII ? /\|====\|/ : /\x1b\[38;5;58;48;5;220m▀/);
  assert.match(renderHeader(24, theme as any, cwd)[0]!, /Honeycomb v/);
  assert.match(renderHeader(24, theme as any, cwd)[0]!, /<\(o\.o\)>/);
  assert.doesNotMatch(renderHeader(7, theme as any, cwd)[0]!, /<\(o\.o\)>/);
});

test('startup bee flaps and hovers, then rests without changing the panel size', t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] });
  let renders = 0;
  const ctx = { cwd: '/project', model: undefined };
  const header = createWelcomeHeader({ requestRender: () => { renders++; } }, theme, ctx, 'shift+tab', true);
  const compact = header.render(69);
  t.mock.timers.tick(150);
  assert.deepEqual(header.render(69), compact);
  assert.equal(renders, 0);

  const resting = renderHeader(70, theme, ctx.cwd);
  const flap = header.render(70);
  t.mock.timers.tick(150);
  const hover = header.render(70);
  if (ASCII) {
    assert.deepEqual(flap, resting);
    assert.deepEqual(hover, resting);
    assert.equal(renders, 0);
  } else {
    assert.notDeepEqual(flap, resting);
    assert.notDeepEqual(hover, flap);
    assert.deepEqual(flap.map(visibleWidth), resting.map(visibleWidth));
    assert.deepEqual(hover.map(visibleWidth), resting.map(visibleWidth));
    assert.equal(renders, 1);
  }
  t.mock.timers.tick(2550);
  assert.deepEqual(header.render(70), flap);
  const beforeLanding = renders;
  t.mock.timers.tick(150);
  assert.deepEqual(header.render(70), resting);
  assert.equal(renders, beforeLanding + (ASCII ? 0 : 1));
  const finished = renders;
  t.mock.timers.tick(3000);
  assert.equal(renders, finished);
});

test('header disposal cancels animation and non-startup headers stay static', t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] });
  const tui = { requestRender: () => assert.fail('unexpected redraw') };
  const ctx = { cwd: '/project', model: undefined };
  const disposed = createWelcomeHeader(tui, theme, ctx, 'shift+tab', true);
  const staticHeader = createWelcomeHeader(tui, theme, ctx, 'shift+tab', false);
  const resting = disposed.render(80);
  assert.deepEqual(staticHeader.render(80), resting);
  disposed.dispose();
  t.mock.timers.tick(450);
  assert.deepEqual(disposed.render(80), resting);
  assert.deepEqual(staticHeader.render(80), resting);
});

test('custom editor scopes Shift+Tab to cycling and preserves text and thinking', () => {
  const tui = { terminal: { rows: 20 }, requestRender() {} } as any;
  let cycles = 0, thinking = 0;
  const editor = new BiPromptEditor(tui, { borderColor: id, selectList: {} } as any, keybindings as any, () => { cycles++; }, id);
  editor.onAction('app.thinking.cycle', () => { thinking++; });
  editor.setText('Keep this draft');
  editor.handleInput('\x1b[Z');
  assert.equal(cycles, 1);
  assert.equal(thinking, 0);
  editor.handleInput('\x1bt');
  assert.equal(thinking, 1);
  assert.equal(editor.getText(), 'Keep this draft');
  assert.match(editor.render(40)[1]!, /(?:>  |❯)Keep this draft/);
  assert.equal(installPromptEditor({ ui: { getEditorComponent: () => () => editor, setEditorComponent: () => assert.fail('existing editor overwritten') } } as any, () => {}), 'alt+m');
});

test('numbered permission prompt defaults to No, pages preview, and closes on Escape', async () => {
  const h = terminalDialog(), prompter = createPermissionPrompter();
  const message = ['\x1b[2J', ...Array.from({ length: 30 }, (_, i) => `step ${i + 1}`)].join('\n');
  const denied = prompter.confirm(h.ctx, 'Run shell command?', message);
  await setImmediate();
  assert.deepEqual(h.blocked, { kind: 'permission', message: 'Run shell command?' });
  assert.match(h.component.render(64).join('\n'), /\\u001b\[2J/);
  assert.ok(h.component.render(14).every(line => visibleWidth(line) <= 14 && !line.includes('\x1b[2J')));
  assert.doesNotMatch(h.component.render(64).join('\n'), /step 15/);
  h.component.handleInput?.('\x1b[6~');
  assert.match(h.component.render(64).join('\n'), /step 15/);
  h.component.handleInput?.('\r');
  assert.equal(await denied, false);

  const accepted = prompter.confirm(h.ctx, 'Run shell command?', 'pwd');
  await setImmediate();
  h.component.handleInput?.('1');
  assert.equal(await accepted, true);

  const dismissed = prompter.confirm(h.ctx, 'Run shell command?', 'pwd');
  await setImmediate();
  h.component.handleInput?.('\x1b');
  assert.equal(await dismissed, false);
});

test('permission dialogs serialize and abort without opening another queued confirmation', async () => {
  const h = terminalDialog(), prompter = createPermissionPrompter(), ac = new AbortController();
  const one = prompter.confirm(h.ctx, 'First?', 'first', ac.signal);
  const two = prompter.confirm(h.ctx, 'Second?', 'second', ac.signal);
  await setImmediate();
  assert.equal(h.count, 1);
  ac.abort();
  assert.deepEqual(await Promise.all([one, two]), [false, false]);
  assert.equal(h.count, 1);
});

test('/permissions displays rule sources and recent denials without exposing arguments', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'bi-rules-view-'));
  try {
    const h = terminalDialog();
    h.ctx.cwd = cwd;
    await mkdir(join(cwd, '.pi'));
    await writeFile(join(cwd, '.pi', 'permission-modes.json'), '{"ask":["write:docs/*"],"deny":["read:.env*"]}');
    const commands = new Map<string, any>();
    registerPermissionRules({ registerCommand(name: string, command: any) { commands.set(name, command.handler); } } as any,
      () => ({ mode: 'Plan', approvals: 1, denials: [{ tool: 'edit', reason: 'Plan mode blocks mutation' }] }));
    const invoke = commands.get('permissions');
    assert.equal(commands.get('allowed-tools'), invoke);
    const opened = invoke('', h.ctx);
    await setImmediate();
    assert.match(h.component.render(80).join('\n'), /Mode: Plan.*1 saved/);
    for (const value of [/\[Project\] write:docs\/\*/, /\[Project\] read:\.env\*/, /edit: Plan mode blocks mutation/]) {
      h.component.handleInput?.('\x1b[C');
      assert.match(h.component.render(80).join('\n'), value);
    }
    h.component.handleInput?.('\x1b');
    await opened;
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('tool display collapses read output, expands on request and keeps failures visible', () => {
  const result = { content: [{ type: 'text', text: 'one\ntwo' }], details: {} } as any;
  const render = toolPresentation('read').renderResult!;
  const ctx = { isError: false, keyHint: () => 'ctrl+o to expand' } as any;
  assert.match(render(result, { expanded: false, isPartial: false }, theme as any, ctx).render(40).join('\n'), /Read 2 lines of output/);
  const expanded = render(result, { expanded: true, isPartial: false }, theme as any, ctx).render(40).join('\n');
  assert.match(expanded, /one/);
  assert.match(expanded, /two/);
  const failure = render({ ...result, content: [{ type: 'text', text: 'Permission declined' }] }, { expanded: false, isPartial: false }, theme as any, { ...ctx, isError: true }).render(40).join('\n');
  assert.match(failure, /Permission declined/);
});
