import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runDiff } from '../../src/tools/git.ts';
import { registerDoctorCommand } from '../../src/commands/doctor.ts';
import { registerTasksCommand, TODO_ENTRY } from '../../src/commands/tasks.ts';

async function temp(fn: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), 'bi-edge-'));
  try { await fn(cwd); } finally { await rm(cwd, { recursive: true, force: true }); }
}

test('Git diff lists literal filenames separately from oversized patch payloads', () => temp(async cwd => {
  const git = (...args: string[]) => execFileSync('git', args, { cwd });
  const odd = 'name[*]\n.txt';
  git('init', '-q');
  await writeFile(join(cwd, odd), 'small patch\n');
  await writeFile(join(cwd, 'huge.txt'), 'large line\n'.repeat(1_050_000));
  git('add', '--', odd, 'huge.txt');
  const ctx = { workingDirectory: cwd, sessionId: 'test' };
  const list = await runDiff(ctx, true, { list: true });
  assert.equal(list.success, true);
  assert.ok((list.metadata?.files as { paths: string[] }[]).some(file => file.paths[0] === odd));
  const small = await runDiff(ctx, true, { paths: [odd] });
  assert.match(small.output ?? '', /\+small patch/);
  const huge = await runDiff(ctx, true, { paths: ['huge.txt'] });
  assert.equal(huge.success, false);
  assert.equal(huge.output, undefined);
}));

function harness(register: (api: any) => void) {
  let handler!: (args: string, ctx: any) => Promise<void>;
  const notices: string[] = [];
  register({ registerCommand(_name: string, command: { handler: typeof handler }) { handler = command.handler; }, getAllTools: () => [], getActiveTools: () => [] });
  return { notices, run: (ctx: object) => handler('', { mode: 'rpc', hasUI: true, isIdle: () => true, hasPendingMessages: () => false, ui: { notify: (text: string) => notices.push(text) }, ...ctx }) };
}

test('/doctor reports malformed configuration without echoing values', () => temp(async cwd => {
  await mkdir(join(cwd, '.pi'));
  await writeFile(join(cwd, '.pi', 'config.json'), '{"password":"SENTINEL_SECRET",');
  await writeFile(join(cwd, '.pi', 'permission-modes.json'), 'SENTINEL_SECRET');
  const h = harness(pi => registerDoctorCommand(pi, { label: 'Manual' } as never));
  await h.run({ cwd, isProjectTrusted: () => false });
  assert.match(h.notices[0]!, /invalid project permission rules/i);
  assert.match(h.notices[0]!, /invalid JSON/i);
  assert.doesNotMatch(h.notices[0]!, /SENTINEL_SECRET/);
}));

test('/tasks reads the currently selected branch on each invocation', async () => {
  const h = harness(registerTasksCommand);
  const todo = (text: string) => ({ type: 'custom', customType: TODO_ENTRY, data: [{ id: '1', text, done: false }] });
  let branch = [todo('first branch item')];
  const ctx = { sessionManager: { getBranch: () => branch } };
  await h.run(ctx);
  branch = [todo('second branch item')];
  await h.run(ctx);
  assert.match(h.notices[0]!, /first branch item/);
  assert.match(h.notices[1]!, /second branch item/);
  assert.doesNotMatch(h.notices[1]!, /first branch item/);
});
