import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createToolSystem } from '../../src/tools/index.ts';

test('rewind restores edits and overwrites, then removes a created file but not its directory', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'bi-rewind-'));
  try {
    await mkdir(join(cwd, 'nested'));
    const { dispatcher } = createToolSystem();
    const ctx = { workingDirectory: cwd, sessionId: 'test', checkUndo: () => true, confirmDestructive: async () => true };
    const run = async (name: string, args = {}) => {
      const result = await dispatcher.dispatch({ name, arguments: args }, ctx);
      assert.equal(result.success, true, result.error);
    };
    const path = 'nested/test.txt';
    const content = () => readFile(join(cwd, path), 'utf8');
    await run('write', { path, content: 'first' });
    await run('write', { path, content: 'second' });
    await run('read', { path });
    await run('edit', { path, old_str: 'second', new_str: 'third' });
    await run('undo');
    assert.equal(await content(), 'second');
    const staleEdit = await dispatcher.dispatch({ name: 'edit', arguments: { path, old_str: 'second', new_str: 'no' } }, ctx);
    assert.equal(staleEdit.success, false);
    assert.match(staleEdit.error ?? '', /has not been read/);
    await run('undo');
    assert.equal(await content(), 'first');
    await run('undo');
    await assert.rejects(content(), { code: 'ENOENT' });
    assert.equal((await stat(join(cwd, 'nested'))).isDirectory(), true);

    await run('write', { path: 'a.txt', content: 'original' });
    await run('write', { path: 'b.txt', content: 'original' });
    await run('apply_patch', { edits: ['a.txt', 'b.txt'].map(path => ({ path, oldText: 'original', newText: 'patched' })) });
    let checks = 0;
    const conflict = await dispatcher.dispatch({ name: 'undo', arguments: {} }, {
      ...ctx, checkUndo: () => { if (++checks === 4) writeFileSync(join(cwd, 'a.txt'), 'user change'); return true; },
    });
    assert.match(conflict.error ?? '', /no restored changes remain/);
    assert.equal(await readFile(join(cwd, 'a.txt'), 'utf8'), 'user change');
    assert.equal(await readFile(join(cwd, 'b.txt'), 'utf8'), 'patched');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
