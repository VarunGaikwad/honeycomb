import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { registerWorktreeCommand } from '../src/commands/worktree.ts';

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bi-worktree-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  await writeFile(path.join(root, 'sample.txt'), 'test\n');
  await writeFile(path.join(root, '.gitattributes'), '*.txt filter=bi-test\n');
  git('add', '.');
  git('-c', 'user.name=Bi Test', '-c', 'user.email=bi@example.invalid', 'commit', '-qm', 'initial');
  let handler!: (args: string, ctx: unknown) => Promise<void>;
  const notices: string[] = [], previews: string[] = [];
  let confirm = async () => true;
  const permissions = { mode: 'auto', subscribe: () => () => {}, prompter: {
    confirm: async (_ctx: unknown, _title: string, preview: string) => { previews.push(preview); return confirm(); },
  } };
  registerWorktreeCommand({ registerCommand: (_name: string, command: { handler: typeof handler }) => { handler = command.handler; } } as never, permissions as never);
  const ctx = { cwd: root, hasUI: true, mode: 'tui', isIdle: () => true, hasPendingMessages: () => false,
    isProjectTrusted: () => true, sessionManager: { getSessionId: () => 'test', getLeafId: () => 'leaf' },
    ui: { notify: (message: string) => notices.push(message) } };
  return { root, git, notices, previews, permissions, run: (input: string, cwd = root) => handler(input, { ...ctx, cwd }),
    onConfirm: (callback: typeof confirm) => { confirm = callback; } };
}

test('/worktree lists, confirms a detached checkout, and leaves dirty work intact', async t => {
  const { root, git, notices, previews, run } = await fixture(t);
  const cwdBefore = process.cwd();
  const originalHead = git('rev-parse', 'HEAD').trim();
  const destination = path.join(root, 'sandbox');
  const hook = path.join(root, '.git', 'hooks', 'post-checkout');
  await writeFile(hook, '#!/bin/sh\nexit 42\n');
  await chmod(hook, 0o700);
  git('config', 'filter.bi-test.smudge', 'exit 43');
  git('config', 'filter.bi-test.required', 'true');
  await run('list');
  assert.match(notices.at(-1)!, /main \(current\)/);
  assert.equal(previews.length, 0);
  await run('create sandbox');
  assert.match(notices.at(-1)!, /^Created a worktree/);
  assert.ok(previews[0]?.includes(destination));
  assert.ok(previews[0]?.includes(originalHead));
  assert.equal(await readFile(path.join(destination, 'sample.txt'), 'utf8'), 'test\n');
  assert.equal(git('symbolic-ref', 'HEAD').trim(), 'refs/heads/main');
  assert.equal(git('-C', destination, 'rev-parse', 'HEAD').trim(), originalHead);
  await run('list', destination);
  assert.match(notices.at(-1)!, /detached [a-f0-9]+ \(current\)/);
  await writeFile(path.join(destination, 'sample.txt'), 'keep this\n');
  await run('leave', destination);
  assert.match(notices.at(-1)!, /local changes/);
  assert.ok(notices.at(-1)?.includes(`start a new Pi session at ${root}`));
  assert.equal(await readFile(path.join(destination, 'sample.txt'), 'utf8'), 'keep this\n');
  assert.ok(git('worktree', 'list', '--porcelain').includes(destination));
  assert.equal(previews.length, 1);
  assert.equal(process.cwd(), cwdBefore);
});

test('/worktree can create two linked checkouts without ignoring unrelated nested repositories', async t => {
  const { root, git, notices, previews, run } = await fixture(t);
  const first = path.join(root, 'first');
  await run('create first');
  assert.match(notices.at(-1)!, /^Created a worktree/);
  assert.match(git('status', '--porcelain=v1', '--untracked-files=all'), /\?\? first\//);
  await writeFile(path.join(first, 'sample.txt'), 'nested work is independent\n');
  await run('create second');
  assert.match(notices.at(-1)!, /^Created a worktree/);
  assert.equal(await readFile(path.join(first, 'sample.txt'), 'utf8'), 'nested work is independent\n');
  await run('leave', first);
  assert.match(notices.at(-1)!, /local changes/);

  const other = path.join(root, 'other');
  await mkdir(other);
  git('-C', other, 'init', '-q');
  git('-C', other, '-c', 'user.name=Bi Test', '-c', 'user.email=bi@example.invalid', 'commit', '--allow-empty', '-qm', 'other');
  await run('create third');
  assert.match(notices.at(-1)!, /local changes/);
  assert.equal(previews.length, 2);
});

test('/worktree refuses unsafe, dirty, cancelled and stale creation requests', async t => {
  const { root, git, notices, previews, permissions, run, onConfirm } = await fixture(t);
  await mkdir(path.join(root, 'sub'));
  await symlink(os.tmpdir(), path.join(root, 'linked'));
  await run('create escape', path.join(root, 'sub'));
  assert.match(notices.at(-1)!, /root of a Git worktree/);
  await run('create ../escape');
  assert.match(notices.at(-1)!, /Usage/);
  await run('create linked');
  assert.match(notices.at(-1)!, /already exists/);
  await run('create node_modules');
  assert.match(notices.at(-1)!, /Unsafe/);
  permissions.mode = 'plan';
  await run('create sandbox');
  assert.match(notices.at(-1)!, /unavailable in Plan/);
  permissions.mode = 'auto';
  await writeFile(path.join(root, 'sample.txt'), 'dirty\n');
  await run('create sandbox');
  assert.match(notices.at(-1)!, /local changes/);
  assert.equal(previews.length, 0);
  await rm(path.join(root, 'linked'));
  await writeFile(path.join(root, 'sample.txt'), 'test\n');
  onConfirm(async () => false);
  await run('create sandbox');
  assert.equal(previews.length, 1);
  onConfirm(async () => { await writeFile(path.join(root, 'untracked'), 'new'); return true; });
  await run('create sandbox');
  assert.equal(previews.length, 2);
  assert.match(notices.at(-1)!, /changed after approval/);
  assert.equal(git('worktree', 'list', '--porcelain').match(/^worktree /gm)?.length, 1);
});
