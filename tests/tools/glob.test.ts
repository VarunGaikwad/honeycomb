import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createToolSystem } from '../../src/tools/index.ts';
import { decidePermission } from '../../src/extension/permission-modes/policy.ts';

async function fixture(t: TestContext) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'bi-glob-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const cwd = path.join(base, 'project');
  await mkdir(cwd);
  const { dispatcher } = createToolSystem();
  const glob = (args: Record<string, unknown>, signal?: AbortSignal) => dispatcher.dispatch({ name: 'glob', arguments: args }, {
    workingDirectory: cwd, sessionId: 'glob-test', signal,
  });
  async function file(name: string, content = '') {
    const full = path.join(cwd, name);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return { base, cwd, glob, file };
}

test('glob matches relative file paths without following symlinks or listing protected or restricted paths', async t => {
  const { base, cwd, glob, file } = await fixture(t);
  for (const name of ['src/a.ts', 'src/nested/b.ts', 'src/no.md', 'src/.env.d/secret.ts', 'src/node_modules/dep.ts', 'src/.bi/memory.ts', 'src/deny.ts', 'src/ask/hidden.ts', '../outside/leak.ts']) await file(name);
  await symlink(path.join(base, 'outside'), path.join(cwd, 'src/external'), 'dir');
  await symlink('nested', path.join(cwd, 'src/alias'), 'dir');
  await symlink('a.ts', path.join(cwd, 'src/link.ts'));
  await file('.pi/permission-modes.json', JSON.stringify({ deny: ['glob:src/deny.ts'], ask: ['glob:src/ask'] }));
  assert.equal((await glob({ pattern: 'src/**/*.ts' })).output, 'src/a.ts\nsrc/nested/b.ts');
  assert.equal((await glob({ pattern: '?.ts', path: 'src' })).output, 'a.ts');
  for (const root of ['../outside', 'src/alias', 'src/external', 'src/.env.d', '.pi']) {
    assert.equal((await glob({ pattern: '**/*.ts', path: root })).success, false, root);
  }
});

test('glob validates arguments, limits matches, and respects cancellation', async t => {
  const { glob, file } = await fixture(t);
  for (const args of [{}, { pattern: '/etc/*' }, { pattern: '../*' }, { pattern: '[a]' }, { pattern: 'a***b' }, { pattern: 'x'.repeat(257) }, { pattern: '*', extra: 1 }, { pattern: '*', path: '' }]) {
    assert.equal((await glob(args)).errorCode, 'INVALID_ARGUMENTS');
  }
  await file('name\nwith-break.txt');
  assert.equal((await glob({ pattern: '*.txt' })).output, 'name\\nwith-break.txt');
  for (let i = 0; i < 201; i++) await file(`${i}.ts`);
  const result = await glob({ pattern: '*.ts' });
  assert.equal(result.output?.split('\n').length, 201);
  assert.match(result.output ?? '', /reached its scan or match limit/);
  assert.equal((await glob({ pattern: '*' }, AbortSignal.abort())).errorCode, 'OPERATION_CANCELLED');
});

test('glob is permitted in Plan mode and respects deny and no-prompt rules', async t => {
  const { cwd } = await fixture(t);
  const input = { pattern: '**/*.ts' };
  assert.equal(decidePermission('plan', 'glob', input, cwd).action, 'allow');
  assert.equal(decidePermission('plan', 'glob', input, cwd, { deny: ['glob:.'], allow: ['glob:.'] }).action, 'deny');
  assert.equal(decidePermission('dontAsk', 'glob', input, cwd, { ask: ['glob:.'] }).action, 'deny');
  assert.equal(decidePermission('plan', 'glob', { ...input, path: '..' }, cwd).action, 'deny');
});
