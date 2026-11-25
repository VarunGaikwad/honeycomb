import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const launcher = join(root, 'bin/bee.js');

test('bee works through an npm-style symlink and forwards session arguments and Pi exit status', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'honeycomb-launcher-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const bee = join(cwd, 'bee');
  await symlink(launcher, bee);
  await writeFile(join(cwd, 'pi'), '#!/bin/sh\nprintf "%s\\n" "$PWD" "$@"\nexit 42\n', { mode: 0o755 });

  const args = ['--offline', '--', 'prompt with spaces; literal'];
  const result = spawnSync(process.execPath, [bee, ...args], { cwd, env: { ...process.env, PATH: cwd }, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 42, result.stderr);
  const [actualCwd, ...actualArgs] = result.stdout.trimEnd().split('\n');
  assert.equal(await realpath(actualCwd!), await realpath(cwd));
  assert.deepEqual(actualArgs, ['--extension', root, ...args]);
});

test('bee reports when Pi is missing', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'honeycomb-launcher-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [launcher], { cwd, env: { ...process.env, PATH: cwd }, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 127);
  assert.match(result.stderr, /Pi was not found on PATH/);
});
