import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { clearLspSelection, needsLspSetup, registerLspMenu, selectedLspServer } from '../src/extension/lsp-menu.ts';
import { installTypeScriptLsp, lspInstallDestination, managedLspServer } from '../src/extension/lsp-install.ts';

const fakeNpm = `#!${process.execPath}
const fs = require('node:fs');
const p = require('node:path');
const args = process.argv.slice(2);
if (args[0] !== 'install' || !args.includes('--ignore-scripts') || !args.includes('--global=false') || !args.includes('--registry=https://registry.npmjs.org/')) process.exit(12);
if (process.env.NPM_TOKEN || process.env.NODE_OPTIONS) process.exit(13);
if (args[args.indexOf('--prefix') + 1] !== process.cwd()) process.exit(14);
for (const flag of ['--userconfig=', '--globalconfig=']) {
  const config = args.find(arg => arg.startsWith(flag)).slice(flag.length);
  if (fs.readFileSync(config, 'utf8') !== '') process.exit(15);
}
fs.mkdirSync('node_modules/.bin', { recursive: true });
fs.writeFileSync('node_modules/.bin/typescript-language-server', '', { mode: 0o700 });
fs.writeFileSync('install-args.json', JSON.stringify(args));
`;

test('installer stages pinned packages privately and refuses symlinked store and cancelled install', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'bi-lsp-install-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const cwd = path.join(base, 'workspace'), home = path.join(base, 'home'), unsafe = path.join(base, 'outside');
  for (const dir of [cwd, home, unsafe]) await mkdir(dir);
  const npm = path.join(base, 'npm');
  await writeFile(npm, fakeNpm, { mode: 0o700 });
  const destination = (await lspInstallDestination(cwd, home))!;
  const signal = new AbortController().signal;
  await assert.rejects(installTypeScriptLsp(cwd, npm, AbortSignal.abort(), destination, home));
  assert.deepEqual(await readdir(home), []);
  await symlink(unsafe, path.join(home, '.bi-lsp'));
  await assert.rejects(installTypeScriptLsp(cwd, npm, signal, destination, home), /Unsafe Honeycomb LSP data folder/);
  assert.deepEqual(await readdir(unsafe), []);
  await rm(path.join(home, '.bi-lsp'));
  const file = await installTypeScriptLsp(cwd, npm, signal, destination, home);
  assert.equal(file, await managedLspServer(cwd, home));
  assert.deepEqual(await readdir(path.dirname(destination)), [path.basename(destination)]);
  const argv: string[] = JSON.parse(await readFile(path.join(destination, 'install-args.json'), 'utf8'));
  assert.deepEqual(argv.slice(0, 3), ['install', 'typescript-language-server@4.3.3', 'typescript@5.9.3']);
  assert.deepEqual(await readdir(cwd), []);
});

test('/lsp menu requires separate install and enable confirmations, then reuses the installed server', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'bi-lsp-menu-'));
  const cwd = path.join(base, 'workspace'), home = path.join(base, 'home');
  for (const dir of [cwd, home]) await mkdir(dir);
  const oldHome = process.env.HOME, oldPath = process.env.PATH;
  t.after(async () => {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    await rm(base, { recursive: true, force: true });
  });
  process.env.HOME = home;
  process.env.PATH = base;
  await writeFile(path.join(base, 'npm'), fakeNpm, { mode: 0o700 });
  const manual = path.join(base, 'manual');
  await writeFile(manual, '', { mode: 0o700 });
  let handler!: Function, active: string[] = ['read'], mode = 'default', trusted = true;
  let choice = 2, confirmations: boolean[] = [];
  const seen: string[] = [];
  const pi = { registerCommand: (_name: string, def: { handler: Function }) => { handler = def.handler; },
    getActiveTools: () => active, setActiveTools: (tools: string[]) => { active = tools; } };
  const permissions = { get mode() { return mode; }, subscribe: () => () => {}, prompter: {
    confirm: async (_ctx: unknown, title: string, body: string) => { seen.push(`${title}\n${body}`); return confirmations.shift() ?? false; },
  } };
  registerLspMenu(pi as never, permissions as never, () => new AbortController().signal);
  const ctx = { cwd, mode: 'tui', hasUI: true, isProjectTrusted: () => trusted, isIdle: () => true, hasPendingMessages: () => false,
    ui: { select: async (_title: string, options: string[]) => { seen.push(options[0]!); return options[choice]; },
      input: async () => manual, notify() {} } };
  await handler('', ctx);
  assert.deepEqual(seen, ['TypeScript / JavaScript — Not installed']);
  choice = 0;
  await handler('', ctx);
  assert.match(seen.at(-1)!, /typescript-language-server@4\.3\.3[\s\S]*Destination:/);
  assert.deepEqual(await readdir(home), []);
  confirmations = [true, false];
  await handler('', ctx);
  assert.match(seen.at(-1)!, /Enable this server/);
  assert.deepEqual(active, ['read']);
  assert.equal(await needsLspSetup(pi as never, cwd), false);
  confirmations = [true];
  await handler('', ctx);
  assert.match(seen.at(-2)!, /Installed$/);
  assert.deepEqual(active, ['read', 'lsp']);
  assert.equal(await selectedLspServer(pi as never, cwd), await managedLspServer(cwd));
  clearLspSelection(pi as never);
  choice = 1;
  confirmations = [true];
  await handler('', ctx);
  assert.equal(await selectedLspServer(pi as never, cwd), manual);
  const count = seen.length;
  mode = 'plan'; await handler('', ctx);
  mode = 'default'; trusted = false; await handler('', ctx);
  assert.equal(seen.length, count);
});
