import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createPermissionModes } from '../../src/extension/permission-modes/index.ts';
import { decidePermission } from '../../src/extension/permission-modes/policy.ts';
import { registerTools } from '../../src/extension/register-tools.ts';
import { createToolSystem } from '../../src/tools/index.ts';

const request = { action: 'definition', path: 'source.ts', language_id: 'typescript', line: 0, character: 2 };
const fake = String.raw`
const {pathToFileURL} = require('node:url');
const {resolve} = require('node:path');
let buffer = Buffer.alloc(0), uri;
const span = {start:{line:0,character:0},end:{line:0,character:1}};
const send = (o) => {
  const b = Buffer.from(JSON.stringify({jsonrpc:'2.0',...o}));
  process.stdout.write('Content-Length: '+b.length+'\r\n\r\n');
  process.stdout.write(b);
};
function handle(m) {
  if(m.method==='initialize') send({id:m.id,result:{capabilities:{positionEncoding:'utf-16',diagnosticProvider:{}}}});
  if(m.method==='textDocument/didOpen') {
    if(m.params.textDocument.text!=='😀abc\n') process.exit(12);
    uri = m.params.textDocument.uri;
    send({id:'edit',method:'workspace/applyEdit',params:{}});
  }
  if(m.id==='edit' && m.error?.code!==-32601) process.exit(13);
  if(m.method==='textDocument/hover') send({id:m.id,result:{contents:{value:'test hover'}}});
  if(m.method==='textDocument/diagnostic') send({id:m.id,result:{items:[{range:span,message:'test diagnostic',severity:2}]}});
  if(['textDocument/definition','textDocument/references'].includes(m.method)) send({id:m.id,result:[
    ...['../outside.ts','.env.ts','symlink.ts','restricted.ts'].map(p=>({uri:pathToFileURL(resolve(p)).href,range:span})),
    {targetUri:uri,targetSelectionRange:span}, {uri:'https://example.invalid/file',range:span}
  ]});
}
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const head = buffer.indexOf('\r\n\r\n');
    if(head < 0) return;
    const n = Number(buffer.subarray(0,head).toString().split(':')[1]);
    if(buffer.length < head+4+n) return;
    const m = JSON.parse(buffer.subarray(head+4,head+4+n));
    buffer = buffer.subarray(head+4+n);
    handle(m);
  }
});
`;

async function fixture(t: TestContext, script = fake) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'bi-lsp-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const cwd = path.join(base, 'workspace');
  const server = path.join(base, 'server');
  await mkdir(cwd);
  await writeFile(server, `#!${process.execPath}\n${script}`, { mode: 0o700 });
  for (const file of ['source.ts', 'restricted.ts', '.env.ts', '../outside.ts']) await writeFile(path.join(cwd, file), '😀abc\n');
  await symlink('source.ts', path.join(cwd, 'symlink.ts'));
  return { cwd, server, source: path.join(cwd, 'source.ts') };
}

test('stdio LSP supports four read-only actions and filters outside, protected and restricted locations', async t => {
  const { cwd, server, source } = await fixture(t);
  const { dispatcher } = createToolSystem();
  const ctx = { workingDirectory: cwd, sessionId: 'lsp', authorizeLsp: async () => server, canReadLspLocation: (file: string) => file === source };
  for (const action of ['definition', 'references', 'hover', 'diagnostics']) {
    const args = action === 'diagnostics' ? { path: 'source.ts', language_id: 'typescript', action } : { ...request, action };
    const result = await dispatcher.dispatch({ name: 'lsp', arguments: args }, ctx);
    assert.equal(result.success, true, result.error);
    if (action === 'hover') assert.equal(JSON.parse(result.output!), 'test hover');
    else if (action === 'diagnostics') assert.equal(JSON.parse(result.output!)[0].message, 'test diagnostic');
    else assert.deepEqual(JSON.parse(result.output!).map((row: { path: string }) => row.path), ['source.ts']);
  }
  assert.equal(await readFile(source, 'utf8'), '😀abc\n');
  for (const file of ['../outside.ts', '.env.ts', 'symlink.ts']) {
    const result = await dispatcher.dispatch({ name: 'lsp', arguments: { ...request, path: file } }, ctx);
    assert.equal(result.success, false);
  }
});

test('push diagnostics are advertised and only accept publications for the opened document', async t => {
  const script = fake.replace("if(m.method==='initialize') send({id:m.id,result:{capabilities:{positionEncoding:'utf-16',diagnosticProvider:{}}}});", `
  if(m.method==='initialize') {
    if(m.params.capabilities.textDocument.publishDiagnostics?.versionSupport!==true) process.exit(14);
    send({id:m.id,result:{capabilities:{positionEncoding:'utf-16'}}});
  }`).replace("send({id:'edit',method:'workspace/applyEdit',params:{}});", `
    const publish = (target, version, message) => send({method:'textDocument/publishDiagnostics',
      params:{uri:target,version,diagnostics:[{range:span,message}]}});
    publish(uri+'-other', 1, 'wrong file');
    publish(uri, 0, 'old version');
    publish(uri, 1, 'push diagnostic');`);
  const { cwd, server } = await fixture(t, script);
  const result = await createToolSystem().dispatcher.dispatch({ name: 'lsp', arguments: {
    path: 'source.ts', language_id: 'typescript', action: 'diagnostics',
  } }, { workingDirectory: cwd, sessionId: 'lsp', authorizeLsp: async () => server });
  assert.equal(result.success, true, result.error);
  assert.equal(JSON.parse(result.output!)[0].message, 'push diagnostic');
});

test('LSP rejects invalid requests, oversized protocol frames and cancellation', async t => {
  const { cwd, server } = await fixture(t, "process.stdout.write('Content-Length: 2000000\\r\\n\\r\\n'); process.stdin.resume();");
  const { dispatcher } = createToolSystem();
  const ctx = { workingDirectory: cwd, sessionId: 'lsp', authorizeLsp: async () => server };
  const call = (args: unknown, signal?: AbortSignal) => dispatcher.dispatch({ name: 'lsp', arguments: args }, { ...ctx, signal });
  assert.equal((await call({ ...request, action: 'rename' })).errorCode, 'INVALID_ARGUMENTS');
  assert.match((await call(request)).error!, /oversized LSP message/);
  const hang = await fixture(t, 'process.stdin.resume();');
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 100);
  try {
    const result = await dispatcher.dispatch({ name: 'lsp', arguments: request }, { ...ctx, workingDirectory: hang.cwd, authorizeLsp: async () => hang.server, signal: abort.signal });
    assert.equal(result.errorCode, 'OPERATION_CANCELLED');
  } finally { clearTimeout(timer); }
});

test('Pi LSP is inactive by default and runs only after trusted one-time approval', async t => {
  const { cwd, server } = await fixture(t);
  const hooks = new Map<string, Function[]>(), tools = new Map<string, any>();
  let active: string[] = [], configured: string | undefined, trusted = false;
  const pi = { on: (name: string, fn: Function) => hooks.set(name, [...hooks.get(name) ?? [], fn]),
    registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand() {}, registerShortcut() {}, registerFlag() {},
    getFlag: (name: string) => name === 'bi-lsp-server' ? configured : undefined,
    getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; } };
  const controller = createPermissionModes(pi as never);
  registerTools(pi as never, controller);
  const prompts: string[] = [];
  const ctx = { cwd, hasUI: true, mode: 'rpc', isProjectTrusted: () => trusted, sessionManager: { getSessionId: () => 'lsp-test' },
    ui: { notify() {}, select: async (title: string) => { prompts.push(title); return 'Allow once'; } } };
  const execute = () => tools.get('lsp').execute('query-id', request, undefined, undefined, ctx);
  const gate = () => hooks.get('tool_call')![0]!({ toolName: 'lsp', input: request, toolCallId: 'query-id' }, ctx);
  assert.equal(tools.get('lsp').defaultActive, false);
  assert.equal((await gate()).block, true);
  configured = server;
  assert.equal((await gate()).block, true);
  trusted = true;
  for (const hook of hooks.get('session_start')!) await hook({ reason: 'startup' }, ctx);
  assert.deepEqual(active, ['lsp']);
  assert.equal((await execute()).isError, true);
  assert.equal(await gate(), undefined);
  assert.equal((await execute()).isError, undefined);
  assert.equal((await execute()).isError, true);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /Server: .* --stdio/);
  assert.equal(decidePermission('plan', 'lsp', request, cwd).action, 'deny');
  assert.equal(decidePermission('dontAsk', 'lsp', request, cwd).action, 'deny');
  assert.equal(decidePermission('auto', 'lsp', request, cwd, { deny: ['read:source.ts'] }).action, 'deny');
});
