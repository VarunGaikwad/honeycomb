import assert from 'node:assert/strict';
import test from 'node:test';
import { createPermissionModes } from '../../src/extension/permission-modes/index.ts';
import { decidePermission } from '../../src/extension/permission-modes/policy.ts';
import { registerTools } from '../../src/extension/register-tools.ts';
import { createWebSearchTool, TAVILY_KEY, WEB_SEARCH_FLAG } from '../../src/tools/web-search.ts';
import { registerWorkingFeedback } from '../../src/tui/working-feedback.ts';

const args = { query: 'Node.js documentation' };
const ctx = { workingDirectory: process.cwd(), sessionId: 'search-test' };

test('Tavily search uses only approved queries, authenticates without exposing the key, and rejects redirects', async () => {
  const key = 'test-only-secret';
  let calls = 0;
  const tool = createWebSearchTool(async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.tavily.com/search');
    assert.equal(options?.method, 'POST');
    assert.equal(options?.redirect, 'error');
    assert.equal(new Headers(options?.headers).get('authorization'), `Bearer ${key}`);
    assert.deepEqual(JSON.parse(String(options?.body)), { ...args, search_depth: 'basic', auto_parameters: false, max_results: 5 });
    return Response.json({ results: [
      { title: 'Node.js', url: 'https://nodejs.org/docs', content: `description ${key}` },
      { title: 'local', url: 'https://127.0.0.1/' },
    ] });
  });
  assert.equal((await tool.execute(args, ctx)).success, false);
  assert.equal(calls, 0);
  const approved = { ...ctx, authorizeWebSearch: () => key };
  const result = await tool.execute(args, approved);
  assert.equal(result.success, true, result.error);
  assert.match(result.output!, /https:\/\/nodejs.org\/docs/);
  assert.doesNotMatch(result.output!, /test-only-secret|127\.0\.0\.1/);
  const failure = createWebSearchTool(async () => new Response(key, { status: 401 }));
  assert.match((await failure.execute(args, approved)).error!, /HTTP 401/);
  const oversized = createWebSearchTool(async () => new Response('x'.repeat(131_073)));
  assert.match((await oversized.execute(args, approved)).error!, /128 KiB/);
  assert.equal((await tool.execute(args, { ...approved, signal: AbortSignal.abort() })).success, false);
  assert.equal(calls, 1);
});

test('web search requires confirmation even with an allow rule; Plan and deny rules block it', () => {
  const decide = (mode: string, rules = {}) => decidePermission(mode, 'web_search', args, ctx.workingDirectory, rules).action;
  assert.equal(decide('auto', { allow: ['web_search:*'] }), 'ask');
  assert.equal(decide('bypassPermissions'), 'ask');
  assert.equal(decide('plan'), 'deny');
  assert.equal(decide('dontAsk'), 'deny');
  assert.equal(decide('auto', { deny: ['web_search:Node.js*'] }), 'deny');
});

test('Pi keeps search inactive without a key and authorizes one exact approved query', async t => {
  const previous = process.env[TAVILY_KEY];
  t.after(() => { if (previous === undefined) delete process.env[TAVILY_KEY]; else process.env[TAVILY_KEY] = previous; });
  delete process.env[TAVILY_KEY];
  const hooks = new Map<string, Function[]>();
  const notices: string[] = [];
  let active: string[] = [], prompts = 0;
  const pi = { on: (name: string, fn: Function) => hooks.set(name, [...hooks.get(name) ?? [], fn]),
    registerTool() {}, registerCommand() {}, registerFlag() {}, registerShortcut() {},
    getFlag: (name: string) => name === WEB_SEARCH_FLAG ? true : undefined,
    getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; },
  };
  const permissions = createPermissionModes(pi as never);
  registerTools(pi as never, permissions);
  const context = { cwd: process.cwd(), mode: 'rpc', hasUI: true, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => 'search-test' }, ui: {
      notify: (text: string) => notices.push(text), select: async () => { prompts++; return 'Allow once'; },
    } };
  const start = async () => { for (const hook of hooks.get('session_start')!) await hook({ reason: 'startup' }, context); };
  const gate = (id: string) => hooks.get('tool_call')![0]!({ toolCallId: id, toolName: 'web_search', input: args }, context);
  const consume = (id: string, input = args) => permissions.consumeCommitApproval(id, context as never, input, 'web_search');
  await start();
  assert.ok(!active.includes('web_search'));
  assert.ok(notices.some(text => text.includes(TAVILY_KEY)));
  assert.equal((await gate('missing')).block, true);
  assert.equal(prompts, 0);
  process.env[TAVILY_KEY] = 'test-only-key';
  await start();
  assert.ok(active.includes('web_search'));
  assert.equal(await gate('changed'), undefined);
  assert.equal(consume('changed', { query: 'different query' }), false);
  assert.equal(await gate('once'), undefined);
  assert.equal(consume('once'), true);
  assert.equal(consume('once'), false);
});

test('missing-key tip only appears for opted-in web search without a key', t => {
  const previous = process.env[TAVILY_KEY];
  t.after(() => { if (previous === undefined) delete process.env[TAVILY_KEY]; else process.env[TAVILY_KEY] = previous; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const firstTip = (enabled: boolean) => {
    let rendered = '';
    const hooks = new Map<string, Function>();
    registerWorkingFeedback({ on: (name: string, handler: Function) => hooks.set(name, handler),
      getFlag: (flag: string) => flag === WEB_SEARCH_FLAG && enabled, getAllTools: () => [{ name: 'web_search' }],
    } as never, { enabled: true, delayMs: 10 });
    hooks.get('agent_start')!({}, { mode: 'tui', ui: { setWorkingMessage() {}, setWidget(_key: string, widget: any) {
      if (widget) rendered = widget({}, { fg: (_color: string, text: string) => text }).render(120)[0];
    } } });
    t.mock.timers.tick(10);
    hooks.get('agent_settled')!();
    return rendered;
  };
  delete process.env[TAVILY_KEY];
  assert.match(firstTip(true), /Set TAVILY_API_KEY/);
  assert.doesNotMatch(firstTip(false), /TAVILY_API_KEY/);
  process.env[TAVILY_KEY] = 'test-only-key';
  assert.doesNotMatch(firstTip(true), /TAVILY_API_KEY|test-only-key/);
});
