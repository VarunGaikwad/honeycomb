import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleWidth } from '@earendil-works/pi-tui';
import { installTui } from '../../src/tui/index.ts';

test('detailed footer handles narrow widths, unknown context and branch changes', () => {
  let footer: any, leaf = 'a';
  let entries: any[] = [];
  const manager = { getEntries: () => entries, getBranch: () => entries, getSessionId: () => 's', getLeafId: () => leaf, getHeader: () => null };
  const ctx: any = { cwd: '/project', model: { name: 'Model', id: 'one', provider: 'p' }, sessionManager: manager, getContextUsage: () => ({ percent: null, contextWindow: 200000 }), ui: {
    setHeader() {}, setFooter(factory: any) { footer = factory({ requestRender() {} }, { fg: (_: string, text: string) => text }, { getGitBranch: () => undefined, onBranchChange: () => () => {} }); },
  } };
  const permissions: any = { mode: 'default', label: 'Manual', cycle() {}, subscribe: () => () => {} };
  installTui(ctx, permissions);
  for (const width of [1, 12, 40, 200]) assert.ok(footer.render(width).every((line: string) => visibleWidth(line) <= width));
  assert.match(footer.render(200)[0], /\? context/);
  assert.match(footer.render(200)[2], /manual mode on/);
  assert.match(footer.render(200)[0], /project$/);
  assert.match(footer.render(200)[1], /est\. \$0\.000$/);
  assert.equal(visibleWidth(footer.render(200)[0]), 200);
  assert.equal(visibleWidth(footer.render(200)[1]), 200);
  entries = [{ type: 'message', message: { role: 'assistant', provider: 'p', model: 'other', usage: { input: 4 } } }]; leaf = 'b';
  assert.match(footer.render(200)[0], /last: p\/other/);
  assert.match(footer.render(200)[1], /4 in/);
  ctx.model = { name: 'Other', id: 'other', provider: 'p' };
  assert.doesNotMatch(footer.render(200)[0], /last:/);
  ctx.getContextUsage = () => ({ percent: 85, contextWindow: 200000 });
  assert.match(footer.render(200)[0], /85%/);
  entries = [...entries, { type: 'compaction', usage: { input: 2 } }]; leaf = 'c';
  assert.match(footer.render(200)[1], /6 in/);
  footer.dispose();
});

test('session totals include other branches while last model follows active branch', () => {
  let footer: any, leaf = 'a', sid = 'first';
  const a = { type: 'message', message: { role: 'assistant', provider: 'p', model: 'a', usage: { input: 10 } } };
  const b = { type: 'message', message: { role: 'assistant', provider: 'p', model: 'b', usage: { input: 20 } } };
  let entries = [a, b];
  const manager = { getEntries: () => entries, getBranch: () => leaf === 'a' ? [a] : [b], getSessionId: () => sid, getLeafId: () => leaf, getHeader: () => null };
  const ctx: any = { cwd: '/project', model: { name: 'Selected', id: 'selected', provider: 'p' }, sessionManager: manager, getContextUsage: () => undefined, ui: {
    setHeader() {}, setFooter(factory: any) { footer = factory({ requestRender() {} }, { fg: (_: string, text: string) => text }, { getGitBranch: () => undefined, onBranchChange: () => () => {} }); },
  } };
  installTui(ctx);
  assert.match(footer.render(200)[0], /last: p\/a/);
  assert.match(footer.render(200)[1], /30 in/);
  leaf = 'b';
  assert.match(footer.render(200)[0], /last: p\/b/);
  assert.match(footer.render(200)[1], /30 in/);
  sid = 'second'; entries = [b];
  assert.match(footer.render(200)[1], /20 in/);
  footer.dispose();
});
