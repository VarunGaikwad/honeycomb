import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createPermissionModes } from '../src/extension/permission-modes/index.ts';
import { decidePermission } from '../src/extension/permission-modes/policy.ts';
import { registerTools } from '../src/extension/register-tools.ts';
import { createWebFetchTool, parseWebUrl, publicAddress, requestPage } from '../src/tools/web-fetch.ts';

const url = 'https://example.org/docs?q=public';
const ctx = { workingDirectory: process.cwd(), sessionId: 'web-test' };

test('web fetch denies unsafe URLs, nonpublic DNS answers and noninteractive policy modes', () => {
  for (const bad of ['http://example.org', 'https://localhost', 'https://foo.internal', 'https://127.1', 'https://0x7f000001',
    'https://[::ffff:127.0.0.1]', 'https://example.org:444', 'https://user:pw@example.org', 'https://@example.org',
    'https:///example.org', 'https://example.org/#fragment', 'https://example.org\\@evil.org']) assert.equal(parseWebUrl(bad), undefined, bad);
  for (const bad of ['10.0.0.2', '100.100.100.200', '127.0.0.1', '169.254.169.254', '168.63.129.16', '172.16.0.1',
    '192.168.1.1', '198.18.1.1', '224.1.0.1', '::ffff:127.0.0.1']) assert.throws(() => publicAddress(['93.184.216.34', bad]), /public IPv4/, bad);
  for (const mode of ['plan', 'dontAsk']) assert.equal(decidePermission(mode, 'web_fetch', { url }, ctx.workingDirectory).action, 'deny');
  assert.equal(decidePermission('bypassPermissions', 'web_fetch', { url }, ctx.workingDirectory, { allow: ['web_fetch:*'] }).action, 'ask');
  assert.equal(decidePermission('auto', 'web_fetch', { url }, ctx.workingDirectory, { deny: ['web_fetch:https://example.org/*'] }).action, 'deny');
});

test('approval precedes DNS; only the validated address reaches the transport', async () => {
  let resolves = 0, requests = 0, addresses = ['127.0.0.1'];
  const tool = createWebFetchTool({
    async resolve(host) { resolves++; assert.equal(host, 'example.org'); return addresses; },
    async request(destination, address) {
      requests++; assert.equal(destination.href, url); assert.equal(address, '93.184.216.34');
      return { success: true, output: 'mock page' };
    },
  });
  assert.equal((await tool.execute({ url }, ctx)).success, false);
  assert.equal(resolves, 0);
  const approved = { ...ctx, authorizeWebFetch: () => true };
  assert.equal((await tool.execute({ url }, approved)).success, false);
  assert.equal(requests, 0);
  addresses = ['93.184.216.34'];
  assert.equal((await tool.execute({ url }, approved)).output, 'mock page');
  assert.equal(requests, 1);
  assert.match((await tool.execute({ url }, { ...approved, signal: AbortSignal.abort() })).error!, /cancelled/);
  assert.equal(resolves, 2);
});

test('HTTPS requests pin DNS, preserve TLS verification, refuse redirects and bound output', async () => {
  const fetch = async (statusCode: number, headers: Record<string, string>, body = '') => {
    let destroyed = false;
    const send = (_url: URL, options: any, onResponse: (response: unknown) => void) => {
      assert.equal(options.method, 'GET');
      assert.equal(options.rejectUnauthorized, true);
      assert.equal(options.family, 4);
      assert.deepEqual(Object.keys(options.headers).sort(), ['Accept', 'Accept-Encoding']);
      options.lookup('example.org', {}, (error: Error | null, address: string, family: number) => {
        assert.equal(error, null); assert.equal(address, '93.184.216.34'); assert.equal(family, 4);
      });
      const response = Object.assign(new EventEmitter(), { statusCode, headers, destroy() { destroyed = true; } });
      return Object.assign(new EventEmitter(), { end() {
        onResponse(response);
        if (!destroyed) response.emit('data', Buffer.from(body));
        if (!destroyed) response.emit('end');
      } });
    };
    return requestPage(new URL(url), '93.184.216.34', new AbortController().signal, send as never);
  };
  assert.match((await fetch(302, { location: '/new' })).error!, /Redirect not followed.*https:\/\/example.org\/new/);
  assert.match((await fetch(302, { location: 'https://127.0.0.1/' })).error!, /no supported destination/);
  assert.match((await fetch(200, { 'content-type': 'image/png' })).error!, /only accepts/);
  assert.match((await fetch(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' })).error!, /uncompressed/);
  assert.match((await fetch(200, { 'content-type': 'text/plain' }, 'x'.repeat(131_073))).error!, /exceeds/);
  assert.match((await fetch(200, { 'content-type': 'text/html; charset=utf-8' }, 'x'.repeat(13_000))).output!, /Untrusted web content[\s\S]*\[truncated\]$/);
});

test('Pi web fetch is inactive by default and binds UI approval to one exact call', async () => {
  const hooks = new Map<string, Function[]>(), tools = new Map<string, any>();
  let active: string[] = [], flag = false, trusted = true;
  const prompts: string[] = [];
  const pi = {
    on: (name: string, fn: Function) => hooks.set(name, [...hooks.get(name) ?? [], fn]),
    registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand() {}, registerFlag() {}, registerShortcut() {},
    getFlag: (name: string) => name === 'bi-web-fetch' ? flag : undefined,
    getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; },
  };
  const permissions = createPermissionModes(pi as never);
  registerTools(pi as never, permissions);
  const context = { cwd: process.cwd(), hasUI: true, mode: 'rpc', isProjectTrusted: () => trusted,
    sessionManager: { getSessionId: () => 'web-test' },
    ui: { notify() {}, select: async (title: string) => { prompts.push(title); return 'Allow once'; } } };
  const start = async () => { for (const hook of hooks.get('session_start')!) await hook({ reason: 'startup' }, context); };
  const gate = (id: string) => hooks.get('tool_call')![0]!({ toolName: 'web_fetch', input: { url }, toolCallId: id }, context);
  const consume = (id: string, destination = url) => permissions.consumeCommitApproval(id, context as never, { url: destination }, 'web_fetch');
  assert.equal(tools.get('web_fetch').defaultActive, false);
  await start();
  assert.ok(!active.includes('web_fetch'));
  assert.equal((await gate('disabled')).block, true);
  flag = true;
  trusted = false;
  await start();
  assert.ok(!active.includes('web_fetch'));
  assert.equal((await gate('untrusted')).block, true);
  trusted = true;
  await start();
  assert.ok(active.includes('web_fetch'));
  assert.equal((await tools.get('web_fetch').execute('no-approval', { url }, undefined, undefined, context)).isError, true);
  assert.equal(await gate('changed'), undefined);
  assert.equal(consume('changed', 'https://example.org/other'), false);
  assert.equal(await gate('once'), undefined);
  assert.equal(consume('once'), true);
  assert.equal(consume('once'), false);
  assert.equal(prompts.length, 2);
  assert.match(prompts[0]!, /GET https:\/\/example.org\/docs\?q=public/);
});
