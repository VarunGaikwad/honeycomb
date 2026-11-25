import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { registerSecurityReviewCommand } from '../src/commands/security-review.ts';

test('/security-review denial does not contact the model or change the session', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'bi-security-review-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd });
    await writeFile(join(cwd, 'change.txt'), 'example\n');
    execFileSync('git', ['add', 'change.txt'], { cwd });
    let handler!: (args: string, ctx: any) => Promise<void>;
    const events = new Map<string, () => void>();
    let prompts = 0, streams = 0;
    const model = { provider: 'test', id: 'test' };
    const permissions = { mode: 'default', prompter: { confirm: async () => { prompts++; return false; } } };
    registerSecurityReviewCommand({ on(event: string, callback: () => void) { events.set(event, callback); }, registerCommand: (_: string, command: any) => { handler = command.handler; }, appendEntry: () => { throw new Error('unexpected write'); } } as never, permissions as never);
    const notices: string[] = [];
    const ctx = { cwd, mode: 'tui', hasUI: true, model, isIdle: () => true, hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => 'session', getLeafId: () => 'leaf' },
      ui: { notify: (text: string) => { notices.push(text); }, custom: () => { throw new Error('unexpected panel'); } },
      modelRegistry: { streamSimple: () => { streams++; throw new Error('unexpected request'); } },
    };
    await handler('staged', ctx);
    assert.equal(prompts, 1);
    assert.equal(streams, 0);
    await writeFile(join(cwd, '.env'), 'secret=value\n');
    execFileSync('git', ['add', '-f', '.env'], { cwd });
    await handler('staged', ctx);
    assert.match(notices.at(-1)!, /protected or unclassifiable paths/);
    assert.equal(prompts, 1, 'protected diff must not reach transmission confirmation');
    assert.equal(streams, 0);
    execFileSync('git', ['rm', '--cached', '-q', '.env'], { cwd });
    await mkdir(join(cwd, '.pi'));
    permissions.prompter.confirm = async () => {
      prompts++;
      await writeFile(join(cwd, '.pi', 'permission-modes.json'), JSON.stringify({ deny: ['read:change.txt'] }));
      return true;
    };
    await handler('staged', ctx);
    assert.equal(prompts, 2);
    assert.equal(streams, 0, 'changed rules must invalidate transmission consent');
    await rm(join(cwd, '.pi', 'permission-modes.json'));
    permissions.prompter.confirm = async () => { prompts++; events.get('session_tree')!(); return true; };
    await handler('staged', ctx);
    assert.equal(prompts, 3);
    assert.equal(streams, 0, 'branch navigation must invalidate transmission consent');
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'test'], { cwd });
    await handler('staged', ctx);
    assert.match(notices.at(-1)!, /No staged tracked changes.*Committed changes are not included/);
    assert.equal(streams, 0);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
