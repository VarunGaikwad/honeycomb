import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isProtectedWrite, isWithin, resolvePermissionPath } from '../src/extension/permission-modes/paths.ts';

test('permission paths resolve existing symlink ancestors for new files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bi-permission-'));
  try {
    const project = path.join(root, 'project');
    const outside = path.join(root, 'outside');
    await mkdir(project); await mkdir(outside);
    await symlink(outside, path.join(project, 'link'));
    const resolved = resolvePermissionPath(project, 'link/new/file');
    assert.equal(resolved, path.join(outside, 'new/file'));
    assert.equal(isWithin(resolvePermissionPath(project, '.'), resolved), false);
    assert.equal(isWithin(project, `${project}-other/file`), false);
    assert.equal(isProtectedWrite(path.join(project, '.env.local')), true);
    assert.equal(isProtectedWrite(path.join(project, '.env-production')), true);
    assert.equal(isProtectedWrite(path.join(project, '.zshenv')), true);
    assert.equal(isProtectedWrite(path.join(project, '.pi/extensions/example.ts')), true);
    assert.equal(isProtectedWrite(path.join(project, 'src/app.ts')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
