import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { link, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createPermissionModes } from '../../src/extension/permission-modes/index.ts';
import { decidePermission } from '../../src/extension/permission-modes/policy.ts';
import { createToolSystem } from '../../src/tools/index.ts';

test('deny rules match the default directory used by ls', () => {
  assert.equal(decidePermission('plan', 'ls', {}, process.cwd(), { deny: ['ls:.'] }).action, 'deny');
});

test('in-place tools refuse multiply linked files without changing content', async t => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'bi-links-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const file = path.join(cwd, 'original.txt');
  await writeFile(file, 'original');
  await link(file, path.join(cwd, 'alias.txt'));
  const { dispatcher } = createToolSystem();
  const context = { workingDirectory: cwd, sessionId: 'test' };
  assert.equal((await dispatcher.dispatch({ name: 'write', arguments: { path: 'alias.txt', content: 'new' } }, context)).success, false);
  assert.equal((await dispatcher.dispatch({ name: 'apply_patch', arguments: { edits: [{ path: 'alias.txt', oldText: 'original', newText: 'new' }] } }, context)).success, false);
  assert.equal(await readFile(file, 'utf8'), 'original');
});

test('a changed destination needs a fresh session approval', async t => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'bi-approval-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const name of ['one', 'two']) await writeFile(path.join(cwd, name), '');
  const alias = path.join(cwd, 'alias');
  await symlink('one', alias);
  const handlers = new Map<string, (...args: any[]) => any>();
  createPermissionModes({ registerShortcut() {}, on(name: string, fn: any) { handlers.set(name, fn); } } as any);
  const gate = handlers.get('tool_call')!;
  const call = { toolName: 'write', input: { path: 'alias', content: 'test' } };
  let prompts = 0;
  const ctx = { cwd, hasUI: true, ui: { select: async () => ++prompts === 1 ? 'Allow exact call for session' : 'Deny' } };
  assert.equal(await gate(call, ctx), undefined);
  await unlink(alias);
  await symlink('two', alias);
  assert.equal((await gate(call, ctx)).block, true);
  assert.equal(prompts, 2);
});

test('terminal command and input cannot share an approval', async () => {
  const args = { command: 'pwd', processId: 'id', input: 'hello' };
  for (const mode of ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']) {
    assert.equal(decidePermission(mode, 'terminal', args, process.cwd()).action, 'deny');
  }
  assert.equal(decidePermission('bypassPermissions', 'terminal', { processId: 'id', input: 'hello' }, process.cwd()).action, 'ask');
  const outcome = await createToolSystem().registry.get('terminal')!.execute(args, { workingDirectory: process.cwd(), sessionId: 'test' });
  assert.match(outcome.error ?? '', /mutually exclusive/);
});

test('memory refuses symlinked and hard-linked state files', async t => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'bi-memory-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(path.join(cwd, '.pi'));
  const original = path.join(cwd, 'original.json');
  const state = path.join(cwd, '.pi', 'memory.json');
  const content = '{"entries":["original"]}';
  await writeFile(original, content);
  const { dispatcher } = createToolSystem();
  for (const connect of [symlink, link]) {
    await connect(original, state);
    const outcome = await dispatcher.dispatch({ name: 'memory', arguments: { action: 'write', content: 'new' } }, { workingDirectory: cwd, sessionId: 'test' });
    assert.equal(outcome.success, false);
    assert.equal(await readFile(original, 'utf8'), content);
    await unlink(state);
  }
});

test('read-only Git status leaves the index unchanged and skips configured filters', async t => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'bi-git-read-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd });
  git('init', '-q');
  await writeFile(path.join(cwd, '.gitattributes'), 'tracked.txt filter=example\n');
  await writeFile(path.join(cwd, 'tracked.txt'), 'before\n');
  git('add', 'tracked.txt');
  const index = path.join(cwd, '.git', 'index');
  const before = await readFile(index);
  await writeFile(path.join(cwd, 'tracked.txt'), 'after\n');
  git('config', 'filter.example.clean', 'touch filter-called; cat');
  git('config', 'filter.example.required', 'true');
  const result = await createToolSystem().registry.get('git_status')!.execute({}, { workingDirectory: cwd, sessionId: 'test' });
  assert.equal(result.success, true, result.error);
  assert.match(result.output ?? '', /tracked\.txt/);
  assert.deepEqual(await readFile(index), before);
  await assert.rejects(readFile(path.join(cwd, 'filter-called')), { code: 'ENOENT' });
});
