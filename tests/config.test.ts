import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BI_CONFIG } from '../src/config/index.ts';
import { ensureProjectConfig } from '../src/config/project.ts';
import { createToolSystem } from '../src/tools/index.ts';
import type { ToolContext } from '../src/types/index.ts';

const execFile = promisify(execFileCallback);

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bi-config-'));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

function context(workingDirectory: string, extras: Partial<ToolContext> = {}): ToolContext {
  return { sessionId: 'config-test-session', workingDirectory, ...extras };
}

test('project config is created with defaults once and existing values are preserved', async () => {
  await withTempDir(async (dir) => {
    const configPath = path.join(dir, '.pi', 'config.json');
    await ensureProjectConfig(dir);
    const initial = JSON.parse(await readFile(configPath, 'utf8'));
    assert.deepEqual(initial, {
      filesystem: BI_CONFIG.filesystem,
      git: BI_CONFIG.git,
      output: BI_CONFIG.output,
      startup: BI_CONFIG.startup,
      systemPrompt: { additional: '' },
    });

    const custom = { startup: { autoEnableQuietStartup: false }, filesystem: { defaultReadLimit: 123 } };
    await writeFile(configPath, `${JSON.stringify(custom)}\n`);
    await ensureProjectConfig(dir);
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), custom);
  });
});

test('tool-system configuration enables and disables tool groups', () => {
  const defaults = createToolSystem();
  assert.equal(defaults.registry.has('read'), BI_CONFIG.toolGroups.filesystem);
  assert.equal(defaults.registry.has('bash'), BI_CONFIG.toolGroups.execution);
  assert.equal(defaults.registry.has('git_status'), BI_CONFIG.toolGroups.git);
  assert.equal(defaults.registry.has('todo'), BI_CONFIG.toolGroups.agent);
  assert.equal(defaults.registry.has('memory'), BI_CONFIG.toolGroups.advanced);

  const configured = createToolSystem({ config: {
    ...BI_CONFIG,
    toolGroups: { ...BI_CONFIG.toolGroups, execution: false, git: false },
  } });
  assert.equal(configured.registry.has('bash'), false);
  assert.equal(configured.registry.has('git_status'), false);
  assert.equal(configured.registry.has('read'), true);
  assert.equal(configured.registry.has('todo'), true);
  assert.equal(configured.registry.has('memory'), true);
  assert.throws(() => createToolSystem({ config: {
    ...BI_CONFIG, execution: { timeoutMs: 0 },
  } }), /execution\.timeoutMs must be a positive integer/);
});

test('tool-system execution timeout can be configured', async () => {
  await withTempDir(async (dir) => {
    const { dispatcher } = createToolSystem({ config: {
      ...BI_CONFIG, execution: { timeoutMs: 50 },
    } });
    const result = await dispatcher.dispatch(
      { name: 'bash', arguments: { command: 'sleep 2' } },
      context(dir, { confirmCommand: async () => true }),
    );
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /Execution timed out/);
  });
});

test('tool-system applies configured filesystem read limits', async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, 'lines.txt'), `first\nsecond\nthird\n${'x'.repeat(25)}`);
    const { dispatcher } = createToolSystem({ config: {
      ...BI_CONFIG,
      filesystem: { ...BI_CONFIG.filesystem, defaultReadLimit: 2, maxReadLineLength: 20 },
    } });

    const result = await dispatcher.dispatch({ name: 'read', arguments: { path: 'lines.txt' } }, context(dir));
    assert.equal(result.success, true);
    assert.match(result.output ?? '', /Showing lines 1-2 of 4\.\.\.$/);
    assert.doesNotMatch(result.output ?? '', /third/);

    const longLine = await dispatcher.dispatch({
      name: 'read', arguments: { path: 'lines.txt', offset: 4, limit: 1 },
    }, context(dir));
    assert.equal([...(longLine.output?.split('\n')[0] ?? '')].length, 20);
    assert.ok(longLine.output?.split('\n')[0].endsWith('... [truncated]'));
  });
});

test('project config overrides safe defaults and caps process output', async () => {
  await withTempDir(async (dir) => {
    const projectState = path.join(dir, '.pi');
    await mkdir(projectState);
    await writeFile(path.join(projectState, 'config.json'), JSON.stringify({
      filesystem: { defaultReadLimit: 1, maxGrepMatches: 2 },
      output: { maxChars: 256 },
      toolGroups: { execution: false },
      execution: { allowCommand: true },
    }));
    await writeFile(path.join(dir, 'lines.txt'), 'first\nsecond\nthird');
    await writeFile(path.join(dir, 'matches.txt'), 'hit one\nhit two\nhit three');
    const { dispatcher, processManager } = createToolSystem();

    const readResult = await dispatcher.dispatch({ name: 'read', arguments: { path: 'lines.txt' } }, context(dir));
    assert.match(readResult.output ?? '', /Showing lines 1-1 of 3\.\.\.$/);
    assert.doesNotMatch(readResult.output ?? '', /second/);

    const grepResult = await dispatcher.dispatch({
      name: 'grep', arguments: { path: '.', query: 'hit' },
    }, context(dir));
    assert.match(grepResult.output ?? '', /Search stopped at the configured limit of 2 matches/);
    assert.doesNotMatch(grepResult.output ?? '', /hit three/);

    const commandCall = { name: 'bash', arguments: { command: "printf '%0500d' 0" } };
    const denied = await dispatcher.dispatch(commandCall, context(dir));
    assert.equal(denied.success, false);
    assert.match(denied.error ?? '', /denied/);

    const commandResult = await dispatcher.dispatch(
      commandCall,
      context(dir, { confirmCommand: async () => true }),
    );
    assert.equal(commandResult.output?.length, 256);
    assert.ok(commandResult.output?.endsWith('\n... [output truncated]'));
    assert.equal(commandResult.metadata?.outputTruncated, true);
    assert.equal(processManager.list(context(dir).sessionId)[0]?.output.length, 256);
  });
});

test('package output limit bounds non-process tool results', async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, 'large.txt'), 'x'.repeat(200));
    const { dispatcher } = createToolSystem({ config: {
      ...BI_CONFIG, output: { maxChars: 64 },
    } });
    const result = await dispatcher.dispatch({ name: 'read', arguments: { path: 'large.txt' } }, context(dir));
    assert.equal(result.output?.length, 64);
    assert.ok(result.output?.endsWith('... [output truncated]'));
  });
});

test('tool-system applies the configured default Git log limit', async () => {
  await withTempDir(async (dir) => {
    await execFile('git', ['init', '-q'], { cwd: dir });
    await execFile('git', ['config', 'user.name', 'Test'], { cwd: dir });
    await execFile('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    for (let index = 1; index <= 3; index++) {
      await writeFile(path.join(dir, 'file.txt'), `commit ${index}`);
      await execFile('git', ['add', 'file.txt'], { cwd: dir });
      await execFile('git', ['commit', '-qm', `commit ${index}`], { cwd: dir });
    }

    await mkdir(path.join(dir, '.pi'), { recursive: true });
    await writeFile(path.join(dir, '.pi', 'config.json'), JSON.stringify({ git: { defaultLogLimit: 2 } }));
    const { dispatcher } = createToolSystem();
    const result = await dispatcher.dispatch({ name: 'git_log', arguments: {} }, context(dir));
    assert.equal(result.success, true);
    assert.equal(result.output?.split('\n').length, 2);
  });
});
