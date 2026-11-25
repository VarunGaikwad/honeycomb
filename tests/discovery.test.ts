import assert from 'node:assert/strict';
import test from 'node:test';
import { registerDiscoveryCommands } from '../src/commands/discovery.ts';

test('discovery views are read-only, bounded and escape terminal controls', async () => {
  const handlers = new Map<string, Function>();
  const notices: string[] = [];
  const pi = {
    registerCommand: (name: string, command: { handler: Function }) => handlers.set(name, command.handler),
    getCommands: () => [{ name: 'skill:odd_2', source: 'skill', description: 'safe\x1b[31m' }],
    getActiveTools: () => ['read'],
    sendUserMessage: () => { throw new Error('unexpected model request'); },
    appendEntry: () => { throw new Error('unexpected session write'); },
    exec: () => { throw new Error('unexpected shell call'); },
  };
  registerDiscoveryCommands(pi as never, { label: 'Manual' } as never);
  const ctx = {
    mode: 'rpc', hasUI: true, ui: { notify: (text: string) => notices.push(text) },
    getSystemPromptOptions: () => ({ skills: [{ name: 'odd', description: 'description\x1b' }], contextFiles: [{ content: 'SECRET' }] }),
    getContextUsage: () => undefined,
    isProjectTrusted: () => false,
    sessionManager: { getBranch: () => [] },
  };
  for (const name of ['help', 'skills', 'context', 'status']) await handlers.get(name)!('', ctx);
  assert.equal(notices.length, 4);
  assert.match(notices[0]!, /skill:odd_2/);
  assert.match(notices[1]!, /Available command: \/skill:odd_2/);
  assert.match(notices[2]!, /Estimated tokens: unknown/);
  assert.match(notices[3]!, /Goal: none/);
  assert.ok(notices.every(text => !text.includes('\x1b') && !text.includes('SECRET') && text.length <= 8000));
});

test('tool search reports live status without exposing definitions or activating tools', async () => {
  const commands = new Map<string, Function>();
  const notices: string[] = [];
  let active = ['read'];
  const tools = [{ name: 'read\x1b', description: 'SECRET' }, { name: 'read' }, { name: 'write' }, { name: 'read' }];
  registerDiscoveryCommands({
    registerCommand: (name: string, command: { handler: Function }) => commands.set(name, command.handler),
    getActiveTools: () => active,
    getAllTools: () => tools,
    setActiveTools: () => assert.fail('must not activate tools'),
  } as never, {} as never);
  const search = commands.get('tool-search')!;
  const ctx = { mode: 'rpc', hasUI: true, ui: { notify: (text: string) => notices.push(text) } };
  await search(' READ ', ctx);
  assert.deepEqual(notices[0]!.split('\n').slice(1), ['Active: read', 'Inactive: read\\u001b']);
  assert.doesNotMatch(notices[0]!, /write|SECRET|\x1b/);
  active = [];
  await search('read', ctx);
  assert.match(notices[1]!, /Inactive: read/);
  await search('nonexistent', ctx);
  assert.match(notices[2]!, /No matching/);
  await search('', { ...ctx, mode: 'json' });
  assert.equal(notices.length, 3);
  tools.push(...Array.from({ length: 201 }, (_, i) => ({ name: `tool_${i}` })));
  await search('tool_', ctx);
  assert.match(notices[3]!, /Showing 198 of 201/);
});
