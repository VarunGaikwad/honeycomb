import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { promisify } from 'node:util';
import { chmod, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createAgentTools } from '../../src/tools/agent.ts';
import { createExecutionTools } from '../../src/tools/execution.ts';
import { createFileSystemTools } from '../../src/tools/filesystem.ts';
import { createGitTools } from '../../src/tools/git.ts';
import { ToolDispatcher } from '../../src/tools/dispatcher.ts';
import { ToolRegistry } from '../../src/tools/registry.ts';
import { registerTools } from '../../src/extension/register-tools.ts';
import type { Tool, ToolContext } from '../../src/tools/types.ts';

const execFile = promisify(execFileCallback);

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bi-tools-'));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

function context(workingDirectory: string, extras: Partial<ToolContext> = {}): ToolContext {
  return { sessionId: 'test-session', workingDirectory, ...extras };
}

async function readBeforeEdit(dispatcher: ToolDispatcher, directory: string, file = 'file.txt'): Promise<void> {
  const result = await dispatcher.dispatch({ name: 'read', arguments: { path: file } }, context(directory));
  assert.equal(result.success, true, result.error);
}

test('registry rejects duplicate names and exposes definitions', () => {
  const registry = new ToolRegistry();
  const tool: Tool = { name: 'hello', description: 'test', parameters: {}, execute: async () => ({ success: true }) };
  registry.register(tool);
  assert.equal(registry.get('hello'), tool);
  assert.deepEqual(registry.definitions(), [{ name: 'hello', description: 'test', parameters: {} }]);
  assert.throws(() => registry.register(tool), /already registered/);
});

test('dispatcher validates arguments, catches failures, and preserves sequential order', async () => {
  const registry = new ToolRegistry();
  const seen: number[] = [];
  registry.register({
    name: 'record', description: 'record', parameters: {},
    validate: (args): args is { n: number } => typeof args === 'object' && args !== null &&
      typeof (args as { n?: unknown }).n === 'number',
    execute: async ({ n }) => { seen.push(n); return { success: true, output: String(n) }; },
  });
  const dispatcher = new ToolDispatcher(registry);
  const ctx = context('/tmp');
  assert.equal((await dispatcher.dispatch({ name: 'record', arguments: { n: 'bad' } }, ctx)).errorCode, 'INVALID_ARGUMENTS');
  assert.equal((await dispatcher.dispatch({ name: 'absent', arguments: {} }, ctx)).errorCode, 'TOOL_NOT_FOUND');
  const results = await dispatcher.dispatchSequential([
    { name: 'record', arguments: { n: 1 } },
    { name: 'record', arguments: { n: 2 } },
  ], ctx);
  assert.deepEqual(seen, [1, 2]);
  assert.deepEqual(results.map((result) => result.output), ['1', '2']);
});

test('filesystem tools confine paths and require approval before deletion', async () => {
  await withTempDir(async (root) => {
    const outside = path.join(root, 'outside');
    const project = path.join(root, 'project');
    await mkdir(project);
    await writeFile(outside, 'outside data');
    await symlink(outside, path.join(project, 'escape'));
    const registry = new ToolRegistry();
    createFileSystemTools().forEach((tool) => registry.register(tool));
    const dispatcher = new ToolDispatcher(registry);
    const ctx = context(project);
    assert.equal((await dispatcher.dispatch({ name: 'read', arguments: { path: '../outside' } }, ctx)).success, false);
    assert.equal((await dispatcher.dispatch({ name: 'read', arguments: { path: 'escape' } }, ctx)).success, false);
    assert.equal((await dispatcher.dispatch({ name: 'write', arguments: { path: 'new.txt', content: 'hello' } }, ctx)).success, true);
    assert.equal((await readFile(path.join(project, 'new.txt'), 'utf8')), 'hello');
    assert.equal((await dispatcher.dispatch({ name: 'write', arguments: { path: 'nested/deep/file.txt', content: 'nested' } }, ctx)).success, true);
    assert.equal(await readFile(path.join(project, 'nested/deep/file.txt'), 'utf8'), 'nested');
    assert.equal((await dispatcher.dispatch({ name: 'delete', arguments: { path: 'new.txt' } }, ctx)).success, false);
    const approved = context(project, { confirmDestructive: async () => true });
    assert.equal((await dispatcher.dispatch({ name: 'delete', arguments: { path: 'new.txt' } }, approved)).success, true);
  });
});

test('read defaults to 2,000 lines, supports offsets and limits, and reports partial ranges', async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, 'lines.txt'), Array.from({ length: 2_005 }, (_, i) => `line-${i + 1}`).join('\n'));
    const registry = new ToolRegistry();
    createFileSystemTools().forEach((tool) => registry.register(tool));
    const dispatcher = new ToolDispatcher(registry);

    const firstPage = await dispatcher.dispatch({ name: 'read', arguments: { path: 'lines.txt' } }, context(dir));
    assert.equal(firstPage.success, true);
    assert.match(firstPage.output ?? '', /line-2000\n\nShowing lines 1-2000 of 2005\.\.\.$/);
    assert.doesNotMatch(firstPage.output ?? '', /line-2001/);

    const lastPage = await dispatcher.dispatch({
      name: 'read', arguments: { path: 'lines.txt', offset: 2_001, limit: 5 },
    }, context(dir));
    assert.equal(lastPage.success, true);
    assert.match(lastPage.output ?? '', /line-2001\nline-2002\nline-2003\nline-2004\nline-2005\n\nShowing lines 2001-2005 of 2005\.\.\.$/);

    const smallContent = 'first\nsecond\n';
    await writeFile(path.join(dir, 'small.txt'), smallContent);
    const small = await dispatcher.dispatch({ name: 'read', arguments: { path: 'small.txt' } }, context(dir));
    assert.equal(small.output, smallContent);
  });
});

test('read truncates overlong lines to 2,000 characters and marks them', async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, 'long.txt'), `${'x'.repeat(2_001)}\nshort`);
    const registry = new ToolRegistry();
    createFileSystemTools().forEach((tool) => registry.register(tool));
    const result = await new ToolDispatcher(registry).dispatch(
      { name: 'read', arguments: { path: 'long.txt', limit: 1 } }, context(dir),
    );
    const line = result.output?.split('\n')[0] ?? '';
    assert.equal(result.success, true);
    assert.equal([...line].length, 2_000);
    assert.ok(line.endsWith('... [truncated]'));
  });
});

test('read ranges are 1-indexed, report exact partial lines, and validate bounds', async () => {
  await withTempDir(async (dir) => {
    const registry = new ToolRegistry();
    createFileSystemTools().forEach((tool) => registry.register(tool));
    const dispatcher = new ToolDispatcher(registry);
    await writeFile(path.join(dir, 'lines.txt'), 'line-1\nline-2\nline-3\nline-4\nline-5\nline-6\n');

    const range = await dispatcher.dispatch({
      name: 'read', arguments: { path: 'lines.txt', offset: 3, limit: 2 },
    }, context(dir));
    assert.equal(range.success, true);
    assert.equal(range.output, 'line-3\nline-4\n\nShowing lines 3-4 of 6...');

    const pastEof = await dispatcher.dispatch({
      name: 'read', arguments: { path: 'lines.txt', offset: 7, limit: 2 },
    }, context(dir));
    assert.equal(pastEof.success, false);
    assert.match(pastEof.error ?? '', /offset 7 is beyond end of file \(6 lines total\)/);

    for (const offset of [0, -1, 1.5]) {
      const invalid = await dispatcher.dispatch({
        name: 'read', arguments: { path: 'lines.txt', offset },
      }, context(dir));
      assert.equal(invalid.success, false);
      assert.match(invalid.error ?? '', /offset.*positive integer/);
    }
    for (const limit of [0, -1, 1.5]) {
      const invalid = await dispatcher.dispatch({
        name: 'read', arguments: { path: 'lines.txt', limit },
      }, context(dir));
      assert.equal(invalid.success, false);
      assert.match(invalid.error ?? '', /limit.*positive integer/);
    }
  });
});

test('read preserves CRLF and files without a final newline', async () => {
  await withTempDir(async (dir) => {
    const registry = new ToolRegistry();
    createFileSystemTools().forEach((tool) => registry.register(tool));
    const dispatcher = new ToolDispatcher(registry);
    await writeFile(path.join(dir, 'crlf.txt'), 'first\r\nsecond\r\nthird');
    const crlf = await dispatcher.dispatch({
      name: 'read', arguments: { path: 'crlf.txt', offset: 2, limit: 1 },
    }, context(dir));
    assert.equal(crlf.output, 'second\r\n\nShowing lines 2-2 of 3...');

    await writeFile(path.join(dir, 'no-final-newline.txt'), 'first\nlast');
    const noFinalNewline = await dispatcher.dispatch({
      name: 'read', arguments: { path: 'no-final-newline.txt', limit: 2 },
    }, context(dir));
    assert.equal(noFinalNewline.success, true);
    assert.equal(noFinalNewline.output, 'first\nlast');
  });
});

test('edit rejects unread files without changing them', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'file.txt');
    await writeFile(file, 'before');
    const registry = new ToolRegistry();
    createFileSystemTools().forEach((tool) => registry.register(tool));
    const dispatcher = new ToolDispatcher(registry);
    const unread = await dispatcher.dispatch({
      name: 'edit', arguments: { path: 'file.txt', old_str: 'before', new_str: 'after' },
    }, context(dir));
    assert.equal(unread.success, false);
    assert.match(unread.error ?? '', /has not been read/);
    assert.equal(await readFile(file, 'utf8'), 'before');
  });
});

test('edit rejects external content changes after read without modifying the file', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'file.txt');
    await writeFile(file, 'before\nuntouched');
    const registry = new ToolRegistry();
    createFileSystemTools().forEach((tool) => registry.register(tool));
    const dispatcher = new ToolDispatcher(registry);
    await readBeforeEdit(dispatcher, dir);
    const readStat = await fs.stat(file);
    await writeFile(file, 'public\nuntouched');
    await fs.utimes(file, readStat.atime, new Date(readStat.mtimeMs + 5_000));

    const stale = await dispatcher.dispatch({
      name: 'edit', arguments: { path: 'file.txt', old_str: 'untouched', new_str: 'edited' },
    }, context(dir));
    assert.equal(stale.success, false);
    assert.match(stale.error ?? '', /has changed since it was read/);
    assert.equal(await readFile(file, 'utf8'), 'public\nuntouched');
  });
});

test('partial reads retain a whole-file snapshot for edits outside the displayed range', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'file.txt');
    await writeFile(file, 'visible\nhidden');
    const registry = new ToolRegistry();
    createFileSystemTools().forEach((tool) => registry.register(tool));
    const dispatcher = new ToolDispatcher(registry);
    const partial = await dispatcher.dispatch({
      name: 'read', arguments: { path: 'file.txt', offset: 1, limit: 1 },
    }, context(dir));
    assert.equal(partial.output, 'visible\n\nShowing lines 1-1 of 2...');
    const result = await dispatcher.dispatch({
      name: 'edit', arguments: { path: 'file.txt', old_str: 'hidden', new_str: 'updated' },
    }, context(dir));
    assert.equal(result.success, true);
    assert.equal(await readFile(file, 'utf8'), 'visible\nupdated');
  });
});

test('partial read of lines 1-10 detects changes outside the range', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'file.txt');
    const original = Array.from({ length: 11 }, (_, index) => `line-${index + 1}`).join('\n');
    await writeFile(file, original);
    const registry = new ToolRegistry();
    createFileSystemTools().forEach((tool) => registry.register(tool));
    const dispatcher = new ToolDispatcher(registry);
    const partial = await dispatcher.dispatch({
      name: 'read', arguments: { path: 'file.txt', offset: 1, limit: 10 },
    }, context(dir));
    assert.equal(partial.success, true);
    assert.match(partial.output ?? '', /Showing lines 1-10 of 11\.\.\.$/);

    const changed = original.replace('line-11', 'changed-line-11');
    await writeFile(file, changed);
    const stale = await dispatcher.dispatch({
      name: 'edit', arguments: {
        path: 'file.txt', old_str: 'line-1\nline-2', new_str: 'LINE-1\nline-2',
      },
    }, context(dir));
    assert.equal(stale.success, false);
    assert.match(stale.error ?? '', /has changed since it was read/);
    assert.equal(await readFile(file, 'utf8'), changed);
  });
});

test('edit accepts a touched partial-read file when its content is unchanged', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'file.txt');
    await writeFile(file, 'visible\nhidden');
    const registry = new ToolRegistry();
    createFileSystemTools().forEach((tool) => registry.register(tool));
    const dispatcher = new ToolDispatcher(registry);
    const partial = await dispatcher.dispatch({
      name: 'read', arguments: { path: 'file.txt', offset: 1, limit: 1 },
    }, context(dir));
    assert.equal(partial.success, true);
    const readStat = await fs.stat(file);
    await fs.utimes(file, readStat.atime, new Date(readStat.mtimeMs + 5_000));
    assert.notEqual((await fs.stat(file)).mtimeMs, readStat.mtimeMs);

    const result = await dispatcher.dispatch({
      name: 'edit', arguments: { path: 'file.txt', old_str: 'hidden', new_str: 'updated' },
    }, context(dir));
    assert.equal(result.success, true);
    assert.equal(await readFile(file, 'utf8'), 'visible\nupdated');
  });
});

test('successful edit refreshes the snapshot for two consecutive edits', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'file.txt');
    await writeFile(file, 'before');
    const registry = new ToolRegistry();
    createFileSystemTools().forEach((tool) => registry.register(tool));
    const dispatcher = new ToolDispatcher(registry);
    await readBeforeEdit(dispatcher, dir);

    const first = await dispatcher.dispatch({
      name: 'edit', arguments: { path: 'file.txt', old_str: 'before', new_str: 'intermediate' },
    }, context(dir));
    const second = await dispatcher.dispatch({
      name: 'edit', arguments: { path: 'file.txt', old_str: 'intermediate', new_str: 'after' },
    }, context(dir));
    assert.equal(first.success, true);
    assert.equal(second.success, true);
    assert.equal(await readFile(file, 'utf8'), 'after');
  });
});

test('file snapshots are isolated per session and keyed by realpath', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'file.txt');
    await writeFile(file, 'before');
    await symlink('file.txt', path.join(dir, 'alias.txt'));
    const registry = new ToolRegistry();
    createFileSystemTools().forEach((tool) => registry.register(tool));
    const dispatcher = new ToolDispatcher(registry);

    await readBeforeEdit(dispatcher, dir);
    const otherSession = context(dir, { sessionId: 'another-session' });
    const isolated = await dispatcher.dispatch({
      name: 'edit', arguments: { path: 'file.txt', old_str: 'before', new_str: 'other' },
    }, otherSession);
    assert.equal(isolated.success, false);
    assert.match(isolated.error ?? '', /has not been read/);

    const throughAlias = await dispatcher.dispatch({
      name: 'edit', arguments: { path: 'alias.txt', old_str: 'before', new_str: 'after' },
    }, context(dir));
    assert.equal(throughAlias.success, true);
    assert.equal(await readFile(file, 'utf8'), 'after');
  });
});

test('filesystem write, apply_patch, and bash do not refresh read snapshots', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'file.txt');
    const registry = new ToolRegistry();
    createFileSystemTools().forEach((tool) => registry.register(tool));
    createAgentTools().forEach((tool) => registry.register(tool));
    createExecutionTools(undefined, { allowCommand: () => true }).tools.forEach((tool) => registry.register(tool));
    const dispatcher = new ToolDispatcher(registry);
    const commandPath = `'${file}'`;
    const mutations = [
      { sessionId: 'write-session', call: { name: 'write', arguments: { path: 'file.txt', content: 'changed' } } },
      { sessionId: 'patch-session', call: { name: 'apply_patch', arguments: { edits: [{ path: 'file.txt', oldText: 'before', newText: 'changed' }] } } },
      { sessionId: 'bash-session', call: { name: 'bash', arguments: { command: `printf changed > ${commandPath}` } } },
    ];

    for (const mutation of mutations) {
      await writeFile(file, 'before');
      const ctx = context(dir, { sessionId: mutation.sessionId });
      assert.equal((await dispatcher.dispatch({ name: 'read', arguments: { path: 'file.txt' } }, ctx)).success, true);
      assert.equal((await dispatcher.dispatch(mutation.call, ctx)).success, true);
      const edit = await dispatcher.dispatch({
        name: 'edit', arguments: { path: 'file.txt', old_str: 'changed', new_str: 'edited' },
      }, ctx);
      assert.equal(edit.success, false);
      assert.match(edit.error ?? '', /has changed since it was read/);
      assert.equal(await readFile(file, 'utf8'), 'changed');
    }
  });
});

test('registered tools use stable Pi session IDs and fail clearly when unavailable', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'file.txt');
    await writeFile(file, 'before');
    const definitions = new Map<string, any>();
    registerTools({ registerTool: (definition: any) => definitions.set(definition.name, definition) } as any);
    const read = definitions.get('read')!;
    const edit = definitions.get('edit')!;
    const firstSession = SessionManager.inMemory(dir);
    const firstId = firstSession.getSessionId();
    assert.equal(firstSession.getSessionId(), firstId);
    const extensionContext = { cwd: dir, hasUI: false, sessionManager: firstSession };

    const readResult = await read.execute('read-call-1', { path: 'file.txt' }, undefined, undefined, extensionContext);
    assert.equal(readResult.isError, undefined);
    const editResult = await edit.execute('edit-call-2', {
      path: 'file.txt', old_str: 'before', new_str: 'after',
    }, undefined, undefined, extensionContext);
    assert.equal(editResult.isError, undefined);

    const nextSession = SessionManager.inMemory(dir);
    assert.notEqual(nextSession.getSessionId(), firstId);
    const isolatedResult = await edit.execute('edit-call-3', {
      path: 'file.txt', old_str: 'after', new_str: 'changed',
    }, undefined, undefined, { cwd: dir, hasUI: false, sessionManager: nextSession });
    assert.equal(isolatedResult.isError, true);
    assert.match(isolatedResult.content[0].text, /has not been read/);

    const unavailable = await read.execute('read-call-4', { path: 'file.txt' }, undefined, undefined, {
      cwd: dir, hasUI: false,
    });
    assert.equal(unavailable.isError, true);
    assert.match(unavailable.content[0].text, /session manager does not expose getSessionId/);
    assert.equal(await readFile(file, 'utf8'), 'after');
  });
});

test('edit replaces a unique exact match and normalizes legacy parameter names', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'file.txt');
    await writeFile(file, 'before\nafter\n');
    const registry = new ToolRegistry();
    createFileSystemTools().forEach((tool) => registry.register(tool));
    const properties = registry.get('edit')!.parameters.properties as Record<string, unknown>;
    assert.deepEqual(Object.keys(properties), ['path', 'old_str', 'new_str', 'replace_all', 'edits']);
    assert.equal(registry.get('edit')!.description.includes('oldText'), false);
    assert.match(registry.get('edit')!.description, /read the file first/i);
    const dispatcher = new ToolDispatcher(registry);
    await readBeforeEdit(dispatcher, dir);
    const result = await dispatcher.dispatch({
      name: 'edit', arguments: { path: 'file.txt', oldText: 'before', newText: 'updated' },
    }, context(dir));
    assert.equal(result.success, true);
    assert.match(result.output ?? '', /^1 replacement in file\.txt\n--- a\/file\.txt\n\+\+\+ b\/file\.txt/);
    assert.equal(await readFile(file, 'utf8'), 'updated\nafter\n');
  });
});

test('edit reports zero matches without changing the file', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'file.txt');
    await writeFile(file, 'unchanged');
    const registry = new ToolRegistry();
    createFileSystemTools().forEach((tool) => registry.register(tool));
    const dispatcher = new ToolDispatcher(registry);
    await readBeforeEdit(dispatcher, dir);
    const result = await dispatcher.dispatch({
      name: 'edit', arguments: { path: 'file.txt', old_str: 'missing', new_str: 'added' },
    }, context(dir));
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /edit 1 failed: old_str was not found/);
    assert.equal(await readFile(file, 'utf8'), 'unchanged');
  });
});

test('edit reports duplicate match count and line numbers', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'file.txt');
    await writeFile(file, 'same\nother\nsame\n');
    const registry = new ToolRegistry();
    createFileSystemTools().forEach((tool) => registry.register(tool));
    const dispatcher = new ToolDispatcher(registry);
    await readBeforeEdit(dispatcher, dir);
    const result = await dispatcher.dispatch({
      name: 'edit', arguments: { path: 'file.txt', old_str: 'same', new_str: 'changed' },
    }, context(dir));
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /matches 2 times on lines 1, 3/);
    assert.match(result.error ?? '', /add more context or set replace_all to true/);
    assert.equal(await readFile(file, 'utf8'), 'same\nother\nsame\n');
  });
});

test('edit replace_all replaces every occurrence and reports the count', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'file.txt');
    await writeFile(file, 'cat dog cat');
    const registry = new ToolRegistry();
    createFileSystemTools().forEach((tool) => registry.register(tool));
    const dispatcher = new ToolDispatcher(registry);
    await readBeforeEdit(dispatcher, dir);
    const result = await dispatcher.dispatch({
      name: 'edit', arguments: { path: 'file.txt', old_str: 'cat', new_str: 'fox', replace_all: true },
    }, context(dir));
    assert.equal(result.success, true);
    assert.match(result.output ?? '', /^2 replacements in file\.txt/);
    assert.equal(await readFile(file, 'utf8'), 'fox dog fox');
  });
});

test('edit applies multiple non-overlapping edits against original content', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'file.txt');
    await writeFile(file, 'alpha beta');
    const registry = new ToolRegistry();
    createFileSystemTools().forEach((tool) => registry.register(tool));
    const dispatcher = new ToolDispatcher(registry);
    await readBeforeEdit(dispatcher, dir);
    const result = await dispatcher.dispatch({
      name: 'edit', arguments: { path: 'file.txt', edits: [
        { old_str: 'alpha', new_str: 'middle' },
        { old_str: 'beta', new_str: 'omega' },
      ] },
    }, context(dir));
    assert.equal(result.success, true);
    assert.match(result.output ?? '', /^2 replacements in file\.txt/);
    assert.equal(await readFile(file, 'utf8'), 'middle omega');
  });
});

test('edit rolls back all earlier edits when a later edit fails', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'file.txt');
    await writeFile(file, 'alpha beta');
    const registry = new ToolRegistry();
    createFileSystemTools().forEach((tool) => registry.register(tool));
    const dispatcher = new ToolDispatcher(registry);
    await readBeforeEdit(dispatcher, dir);
    const result = await dispatcher.dispatch({
      name: 'edit', arguments: { path: 'file.txt', edits: [
        { old_str: 'alpha', new_str: 'changed' },
        { old_str: 'missing', new_str: 'replacement' },
      ] },
    }, context(dir));
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /edit 2 failed: old_str was not found/);
    assert.equal(await readFile(file, 'utf8'), 'alpha beta');
  });
});

test('edit preserves CRLF line endings and a UTF-8 BOM', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'file.txt');
    await writeFile(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('first\r\nsecond\r\n')]));
    const registry = new ToolRegistry();
    createFileSystemTools().forEach((tool) => registry.register(tool));
    const dispatcher = new ToolDispatcher(registry);
    await readBeforeEdit(dispatcher, dir);
    const result = await dispatcher.dispatch({
      name: 'edit', arguments: { path: 'file.txt', old_str: 'first', new_str: 'updated\nline' },
    }, context(dir));
    assert.equal(result.success, true);
    assert.deepEqual(await readFile(file), Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('updated\r\nline\r\nsecond\r\n'),
    ]));
  });
});

test('edit validates empty and identical text, missing files, and binary/non-UTF-8 files', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'file.txt');
    const registry = new ToolRegistry();
    createFileSystemTools().forEach((tool) => registry.register(tool));
    const dispatcher = new ToolDispatcher(registry);
    await writeFile(file, 'text');
    await readBeforeEdit(dispatcher, dir);
    const empty = await dispatcher.dispatch({ name: 'edit', arguments: {
      path: 'file.txt', old_str: '', new_str: 'x',
    } }, context(dir));
    assert.match(empty.error ?? '', /old_str must not be empty/);
    const identical = await dispatcher.dispatch({ name: 'edit', arguments: {
      path: 'file.txt', old_str: 'text', new_str: 'text',
    } }, context(dir));
    assert.match(identical.error ?? '', /old_str and new_str must be different/);
    const missing = await dispatcher.dispatch({ name: 'edit', arguments: {
      path: 'absent.txt', old_str: 'text', new_str: 'new',
    } }, context(dir));
    assert.match(missing.error ?? '', /file not found/);
    await writeFile(file, Buffer.from([0x61, 0x00, 0x62]));
    await readBeforeEdit(dispatcher, dir);
    const binary = await dispatcher.dispatch({ name: 'edit', arguments: {
      path: 'file.txt', old_str: 'a', new_str: 'b',
    } }, context(dir));
    assert.match(binary.error ?? '', /binary file/);
    await writeFile(file, Buffer.from([0xff, 0xfe]));
    await readBeforeEdit(dispatcher, dir);
    const invalidUtf8 = await dispatcher.dispatch({ name: 'edit', arguments: {
      path: 'file.txt', old_str: 'a', new_str: 'b',
    } }, context(dir));
    assert.match(invalidUtf8.error ?? '', /not valid UTF-8/);
  });
});

test('edit returns clear errors for missing params, mixed forms, and empty edits', async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, 'file.txt'), 'text');
    const registry = new ToolRegistry();
    createFileSystemTools().forEach((tool) => registry.register(tool));
    const dispatcher = new ToolDispatcher(registry);
    await readBeforeEdit(dispatcher, dir);
    const noParams = await dispatcher.dispatch({ name: 'edit', arguments: { path: 'file.txt' } }, context(dir));
    assert.match(noParams.error ?? '', /provide old_str\/new_str or a non-empty edits array/);
    const mixed = await dispatcher.dispatch({ name: 'edit', arguments: {
      path: 'file.txt', old_str: 'text', new_str: 'new', edits: [{ old_str: 'text', new_str: 'other' }],
    } }, context(dir));
    assert.match(mixed.error ?? '', /provide either old_str\/new_str or edits, not both/);
    const empty = await dispatcher.dispatch({ name: 'edit', arguments: { path: 'file.txt', edits: [] } }, context(dir));
    assert.match(empty.error ?? '', /"edits" must not be empty/);
  });
});

test('edit preserves executable mode bits across atomic replacement', async () => {
  const originalUmask = process.umask(0o022);
  try {
    await withTempDir(async (dir) => {
      const file = path.join(dir, 'run.sh');
      await writeFile(file, '#!/bin/sh\necho before\n');
      await chmod(file, 0o777);
      const registry = new ToolRegistry();
      createFileSystemTools().forEach((tool) => registry.register(tool));
      const dispatcher = new ToolDispatcher(registry);
      await readBeforeEdit(dispatcher, dir, 'run.sh');
      const result = await dispatcher.dispatch({
        name: 'edit', arguments: { path: 'run.sh', old_str: 'before', new_str: 'after' },
      }, context(dir));
      assert.equal(result.success, true);
      assert.equal((await lstat(file)).mode & 0o777, 0o777);
    });
  } finally {
    process.umask(originalUmask);
  }
});

test('edit preserves same-directory and different-directory symlinks', async () => {
  await withTempDir(async (dir) => {
    const sameDir = path.join(dir, 'same');
    const linksDir = path.join(dir, 'links');
    const targetsDir = path.join(dir, 'targets');
    await Promise.all([mkdir(sameDir), mkdir(linksDir), mkdir(targetsDir)]);
    await writeFile(path.join(sameDir, 'target.txt'), 'same before');
    await writeFile(path.join(targetsDir, 'target.txt'), 'different before');
    await symlink('target.txt', path.join(sameDir, 'alias.txt'));
    await symlink('../targets/target.txt', path.join(linksDir, 'alias.txt'));
    const registry = new ToolRegistry();
    createFileSystemTools().forEach((tool) => registry.register(tool));
    const dispatcher = new ToolDispatcher(registry);
    await readBeforeEdit(dispatcher, dir, 'same/alias.txt');
    const fsWithOpen = fs as unknown as { open: (...args: any[]) => Promise<unknown> };
    const originalOpen = fsWithOpen.open.bind(fsWithOpen);
    const tempDirectories: string[] = [];
    fsWithOpen.open = async (...args: any[]) => {
      const filename = String(args[0]);
      if (filename.endsWith('.tmp')) tempDirectories.push(path.dirname(filename));
      return originalOpen(...args);
    };
    try {
      const same = await dispatcher.dispatch({ name: 'edit', arguments: {
        path: 'same/alias.txt', old_str: 'before', new_str: 'after',
      } }, context(dir));
      await readBeforeEdit(dispatcher, dir, 'links/alias.txt');
      const different = await dispatcher.dispatch({ name: 'edit', arguments: {
        path: 'links/alias.txt', old_str: 'before', new_str: 'after',
      } }, context(dir));
      assert.equal(same.success, true);
      assert.equal(different.success, true);
      assert.equal((await lstat(path.join(sameDir, 'alias.txt'))).isSymbolicLink(), true);
      assert.equal((await lstat(path.join(linksDir, 'alias.txt'))).isSymbolicLink(), true);
      assert.equal(await readFile(path.join(sameDir, 'target.txt'), 'utf8'), 'same after');
      assert.equal(await readFile(path.join(targetsDir, 'target.txt'), 'utf8'), 'different after');
      assert.deepEqual(tempDirectories, [await fs.realpath(sameDir), await fs.realpath(targetsDir)]);
    } finally {
      fsWithOpen.open = originalOpen;
    }
  });
});

test('edit matches LF multi-line old_str in a CRLF file', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'file.txt');
    await writeFile(file, 'top\r\nfirst\r\nsecond\r\nbottom\r\n');
    const registry = new ToolRegistry();
    createFileSystemTools().forEach((tool) => registry.register(tool));
    const dispatcher = new ToolDispatcher(registry);
    await readBeforeEdit(dispatcher, dir);
    const result = await dispatcher.dispatch({
      name: 'edit', arguments: { path: 'file.txt', old_str: 'first\nsecond', new_str: 'one\ntwo' },
    }, context(dir));
    assert.equal(result.success, true);
    assert.equal(await readFile(file, 'utf8'), 'top\r\none\r\ntwo\r\nbottom\r\n');
  });
});

test('edit preserves untouched line endings in mixed-ending files', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'mixed.txt');
    await writeFile(file, 'head\r\nreplace\r\nlf-after\nkeep\n');
    const registry = new ToolRegistry();
    createFileSystemTools().forEach((tool) => registry.register(tool));
    const dispatcher = new ToolDispatcher(registry);
    await readBeforeEdit(dispatcher, dir, 'mixed.txt');
    const result = await dispatcher.dispatch({
      name: 'edit', arguments: { path: 'mixed.txt', old_str: 'replace', new_str: 'one\ntwo' },
    }, context(dir));
    assert.equal(result.success, true);
    assert.equal(await readFile(file, 'utf8'), 'head\r\none\r\ntwo\r\nlf-after\nkeep\n');
  });
});

test('edit supports per-item replace_all in edits', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'file.txt');
    await writeFile(file, 'cat cat dog');
    const registry = new ToolRegistry();
    createFileSystemTools().forEach((tool) => registry.register(tool));
    const dispatcher = new ToolDispatcher(registry);
    await readBeforeEdit(dispatcher, dir);
    const result = await dispatcher.dispatch({
      name: 'edit', arguments: { path: 'file.txt', edits: [
        { old_str: 'cat', new_str: 'fox', replace_all: true },
        { old_str: 'dog', new_str: 'wolf' },
      ] },
    }, context(dir));
    assert.equal(result.success, true);
    assert.match(result.output ?? '', /^3 replacements in file\.txt/);
    assert.equal(await readFile(file, 'utf8'), 'fox fox wolf');
  });
});

test('edit truncates long unified diffs', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'many.txt');
    await writeFile(file, 'match\n'.repeat(120));
    const registry = new ToolRegistry();
    createFileSystemTools().forEach((tool) => registry.register(tool));
    const dispatcher = new ToolDispatcher(registry);
    await readBeforeEdit(dispatcher, dir, 'many.txt');
    const result = await dispatcher.dispatch({
      name: 'edit', arguments: { path: 'many.txt', old_str: 'match', new_str: 'changed', replace_all: true },
    }, context(dir));
    assert.equal(result.success, true);
    assert.match(result.output ?? '', /\.\.\. diff truncated \.\.\./);
    assert.ok((result.output?.length ?? 0) < 5_000);
  });
});

test('edit rejects overlapping original ranges and names both edits', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'file.txt');
    await writeFile(file, 'abcdefgh');
    const registry = new ToolRegistry();
    createFileSystemTools().forEach((tool) => registry.register(tool));
    const dispatcher = new ToolDispatcher(registry);
    await readBeforeEdit(dispatcher, dir);
    const result = await dispatcher.dispatch({
      name: 'edit', arguments: { path: 'file.txt', edits: [
        { old_str: 'bcd', new_str: 'X' },
        { old_str: 'cde', new_str: 'Y' },
      ] },
    }, context(dir));
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /edit 1 overlaps edit 2/);
    assert.equal(await readFile(file, 'utf8'), 'abcdefgh');
  });
});

test('later edits do not match text produced by earlier edits', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'file.txt');
    await writeFile(file, 'alpha');
    const registry = new ToolRegistry();
    createFileSystemTools().forEach((tool) => registry.register(tool));
    const dispatcher = new ToolDispatcher(registry);
    await readBeforeEdit(dispatcher, dir);
    const result = await dispatcher.dispatch({
      name: 'edit', arguments: { path: 'file.txt', edits: [
        { old_str: 'alpha', new_str: 'middle' },
        { old_str: 'middle', new_str: 'omega' },
      ] },
    }, context(dir));
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /edit 2 failed: old_str was not found/);
    assert.equal(await readFile(file, 'utf8'), 'alpha');
  });
});

test('shell execution honors command policy and cancellation', async () => {
  const noPolicy = createExecutionTools();
  const noPolicyRegistry = new ToolRegistry();
  noPolicy.tools.forEach((tool) => noPolicyRegistry.register(tool));
  const deniedByDefault = await new ToolDispatcher(noPolicyRegistry).dispatch(
    { name: 'bash', arguments: { command: 'echo unsafe' } },
    context(process.cwd()),
  );
  assert.equal(deniedByDefault.success, false);

  const { tools } = createExecutionTools(undefined, { allowCommand: () => false });
  const registry = new ToolRegistry();
  tools.forEach((tool) => registry.register(tool));
  const result = await new ToolDispatcher(registry).dispatch(
    { name: 'bash', arguments: { command: 'echo unsafe' } },
    context(process.cwd()),
  );
  assert.equal(result.success, false);
  assert.match(result.error ?? '', /denied/);

  const controller = new AbortController();
  controller.abort();
  const allowed = createExecutionTools(undefined, { allowCommand: () => true });
  const allowedRegistry = new ToolRegistry();
  const dispatcher = new ToolDispatcher(allowedRegistry);
  allowed.tools.forEach((tool) => allowedRegistry.register(tool));
  const cancelled = await dispatcher.dispatch(
    { name: 'bash', arguments: { command: 'echo should-not-run' } },
    context(process.cwd(), { signal: controller.signal }),
  );
  assert.equal(cancelled.errorCode, 'OPERATION_CANCELLED');
});

test('apply_patch undo restores agent changes and refuses to overwrite later edits', async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, 'file.txt'), 'before');
    const registry = new ToolRegistry();
    createAgentTools().forEach((tool) => registry.register(tool));
    const patchTool = registry.get('apply_patch')!;
    assert.deepEqual((patchTool.parameters.properties as Record<string, any>).edits.items.required, [
      'path', 'oldText', 'newText',
    ]);
    const dispatcher = new ToolDispatcher(registry);
    const ctx = context(dir);
    const patch = { name: 'apply_patch', arguments: { edits: [{ path: 'file.txt', oldText: 'before', newText: 'after' }] } };
    assert.equal((await dispatcher.dispatch(patch, ctx)).success, true);
    assert.equal((await dispatcher.dispatch({ name: 'undo', arguments: {} }, ctx)).success, true);
    assert.equal(await readFile(path.join(dir, 'file.txt'), 'utf8'), 'before');
    assert.equal((await dispatcher.dispatch(patch, ctx)).success, true);
    await writeFile(path.join(dir, 'file.txt'), 'user edit');
    const undo = await dispatcher.dispatch({ name: 'undo', arguments: {} }, ctx);
    assert.equal(undo.success, false);
    assert.equal(await readFile(path.join(dir, 'file.txt'), 'utf8'), 'user edit');
    await writeFile(path.join(dir, 'file.txt'), 'after');
    let asked = false;
    const refused = await dispatcher.dispatch({ name: 'undo', arguments: {} }, {
      ...ctx, checkUndo: () => true,
      confirmDestructive: async () => { asked = true; await writeFile(path.join(dir, 'file.txt'), 'edited during confirmation'); return true; },
    });
    assert.equal(asked, true);
    assert.equal(refused.success, false);
    assert.equal(await readFile(path.join(dir, 'file.txt'), 'utf8'), 'edited during confirmation');
    await writeFile(path.join(dir, 'file.txt'), 'user edit');
    const duplicate = await dispatcher.dispatch({
      name: 'apply_patch',
      arguments: { edits: [
        { path: 'file.txt', oldText: 'user', newText: 'other' },
        { path: 'file.txt', oldText: 'edit', newText: 'change' },
      ] },
    }, ctx);
    assert.equal(duplicate.success, false);
  });
});

test('ask_user is opt-in and validates structured questions before invoking the UI', async () => {
  assert.equal(createAgentTools().some((tool) => tool.name === 'ask_user'), false);
  let asked = false;
  const askTool = createAgentTools({ askUser: async (questions) => {
    asked = true;
    assert.equal(questions.length, 1);
    return { status: 'answered', answers: [{ id: 'animal', selected: ['Mammal'], customText: null }] };
  } }).find((tool) => tool.name === 'ask_user')!;
  assert.equal(askTool.validate?.({ questions: [] }), true);
  const result = await askTool.execute({ questions: [] }, context('/tmp'));
  assert.equal(result.success, false);
  assert.equal(asked, false);
  const valid = { questions: [{
    id: 'animal', header: 'Animal', question: 'What kind?', multiSelect: false,
    options: [{ label: 'Mammal', description: 'Warm-blooded' }, { label: 'Bird', description: 'Has feathers' }],
  }] };
  assert.equal(askTool.validate?.(valid), true);
  assert.equal((await askTool.execute(valid, context('/tmp'))).success, true);
  assert.equal(asked, true);
});

test('git tools invoke git safely in the configured working directory', async () => {
  await withTempDir(async (dir) => {
    await execFile('git', ['init', '-q'], { cwd: dir });
    await writeFile(path.join(dir, 'file.txt'), 'tracked');
    const registry = new ToolRegistry();
    createGitTools().forEach((tool) => registry.register(tool));
    const result = await new ToolDispatcher(registry).dispatch(
      { name: 'git_status', arguments: {} },
      context(dir),
    );
    assert.equal(result.success, true);
    assert.match(result.output ?? '', /file\.txt/);
  });
});
