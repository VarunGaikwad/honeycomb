import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { registerDiffCommand } from '../../src/commands/diff.ts';

test('/diff reuses an approved sensitive list on return, but asks for the patch', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'bi-diff-sensitive-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  try {
    git('init', '-q');
    await writeFile(join(cwd, '.env'), 'fixture\n');
    git('add', '.env');
    await mkdir(join(cwd, '.pi'));
    await writeFile(join(cwd, '.pi', 'permission-modes.json'), '{"ask":["git_diff:*"]}');
    let handler!: (args: string, ctx: unknown) => Promise<void>;
    const confirmations: string[] = [], views: string[] = [];
    registerDiffCommand({ registerCommand(_name: string, command: { handler: typeof handler }) { handler = command.handler; } } as never,
      { mode: 'default', prompter: { confirm: async (_ctx: unknown, title: string) => { confirmations.push(title); return true; } } } as never);
    await handler('staged', {
      cwd, mode: 'tui', hasUI: true, isIdle: () => true, hasPendingMessages: () => false,
      sessionManager: { getLeafId: () => null, getSessionId: () => 'test' },
      ui: { custom: (factory: Function) => new Promise(done => {
        const component = factory({ terminal: { rows: 24 }, requestRender() {
          views.push(component.render(120).join('\n'));
          component.handleInput(views.length === 1 ? 'tui.select.confirm' : 'tui.select.cancel');
        } }, { fg: (_color: string, text: string) => text }, { matches: (input: string, key: string) => input === key }, done);
      }) },
    });
    assert.deepEqual(confirmations, ['Open Git diff?', 'Allow sensitive Git diff?', 'Allow sensitive Git diff?']);
    assert.match(views[2]!, /Previously loaded file list/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('/diff switches between staged and unstaged changes without modifying Git state', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'bi-diff-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  try {
    git('init', '-q');
    await writeFile(join(cwd, 'example.txt'), 'staged text\n');
    git('add', 'example.txt');
    await writeFile(join(cwd, 'example.txt'), 'unstaged text\n');
    const before = git('status', '--porcelain');
    let handler!: (args: string, ctx: unknown) => Promise<void>;
    registerDiffCommand({ registerCommand(_name: string, command: { handler: typeof handler }) {
      handler = command.handler;
    } } as never, { mode: 'plan' } as never);
    const views: string[] = [];
    await handler('', {
      cwd, mode: 'tui', hasUI: true, isIdle: () => true, hasPendingMessages: () => false,
      sessionManager: { getLeafId: () => null, getSessionId: () => 'test' },
      ui: { custom: (factory: Function) => new Promise(done => {
        const component = factory({ terminal: { rows: 24 }, requestRender() {
          views.push(component.render(120).join('\n'));
          const key = ['tui.select.confirm', 'tui.select.cancel', 'tui.input.tab', 'tui.select.confirm', 'tui.select.cancel', 'tui.select.cancel'][views.length - 1] ?? 'tui.select.cancel';
          component.handleInput(key);
        } }, { fg: (_color: string, text: string) => text }, { matches: (input: string, key: string) => input === key }, done);
      }) },
    });
    assert.match(views[0], /> M example\.txt/);
    assert.doesNotMatch(views[0], /\+unstaged text/);
    assert.match(views[1], /unstaged\n[\s\S]*\+unstaged text/);
    assert.match(views[3], / — staged\n[\s\S]*> A example\.txt/);
    assert.match(views[4], / — staged\n[\s\S]*\+staged text/);
    assert.equal(git('status', '--porcelain'), before);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
