import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProjectConfig } from '../../src/config/project.ts';

test('footer style accepts only supported values and reports invalid preferences', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bi-footer-config-'));
  try {
    await mkdir(join(dir, '.pi'));
    const file = join(dir, '.pi', 'config.json');
    await writeFile(file, JSON.stringify({ ui: { footerStyle: 'compact' } }));
    assert.equal((await loadProjectConfig(dir)).ui?.footerStyle, 'compact');
    await writeFile(file, JSON.stringify({ ui: { footerStyle: 'invalid' } }));
    const issues: string[] = [];
    assert.equal((await loadProjectConfig(dir, issue => issues.push(issue))).ui, undefined);
    assert.ok(issues.some(issue => issue.includes('ui.footerStyle')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
