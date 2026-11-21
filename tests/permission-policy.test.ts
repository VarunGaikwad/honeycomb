import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { decidePermission } from '../src/extension/permission-modes/policy.ts';

test('policy denies protected writes including symlink targets', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'bi-policy-'));
  try {
    await symlink('.env', path.join(cwd, 'link'));
    assert.equal(decidePermission('default', 'write', { path: '.env.local' }, cwd).action, 'deny');
    assert.equal(decidePermission('default', 'move', { source: 'a', destination: '.git/config' }, cwd).action, 'deny');
    assert.equal(decidePermission('default', 'apply_patch', { edits: [{ path: 'src/a' }, { path: '.env' }] }, cwd).action, 'deny');
    assert.equal(decidePermission('default', 'apply_patch', { edits: [{ path: 'src/a' }, {}] }, cwd).action, 'deny');
    assert.equal(decidePermission('default', 'apply_patch', { edits: [{ path: 'src/a', oldText: 'a', newText: 'b' }] }, cwd).action, 'ask');
    assert.equal(decidePermission('default', 'write', { path: 'link' }, cwd).action, 'deny');
    assert.equal(decidePermission('default', 'write', { path: 'src/a', content: '' }, cwd).action, 'ask');
    assert.equal(decidePermission('acceptEdits', 'write', { path: 'src/a', content: '' }, cwd).action, 'allow');
    assert.equal(decidePermission('auto', 'edit', { path: 'src/a', old_str: 'a', new_str: 'b' }, cwd).action, 'allow');
    assert.equal(decidePermission('acceptEdits', 'write', { path: '../outside', content: '' }, cwd).action, 'ask');
    assert.equal(decidePermission('acceptEdits', 'write', { path: '.env' }, cwd).action, 'deny');
    assert.equal(decidePermission('acceptEdits', 'copy', { source: '.env', destination: 'safe' }, cwd).action, 'ask');
    assert.equal(decidePermission('default', 'mystery', {}, cwd).action, 'ask');
    assert.equal(decidePermission('plan', 'read', { path: 'src/a' }, cwd).action, 'allow');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
