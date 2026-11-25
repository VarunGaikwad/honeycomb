import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { isWithin } from './permission-modes/paths.ts';
import { resolveLspServer } from '../tools/lsp.ts';

const registry = 'https://registry.npmjs.org/';
export const lspPackages = ['typescript-language-server@4.3.3', 'typescript@5.9.3'] as const;
const installName = 'typescript-4.3.3-ts-5.9.3';
const serverPath = (dir: string) => path.join(dir, 'node_modules', '.bin', 'typescript-language-server');
const run = promisify(execFile);

async function locations(cwd: string, home: string) {
  const realHome = await fs.realpath(home);
  const workspace = await fs.realpath(cwd);
  const root = path.join(realHome, '.bi-lsp');
  if (isWithin(workspace, root)) return;
  return { root, version: path.join(root, installName) };
}

async function privateDir(dir: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(dir);
    return stat.isDirectory() && (stat.mode & 0o022) === 0 && stat.uid === process.getuid?.();
  } catch { return false; }
}

export async function lspInstallDestination(cwd: string, home = os.homedir()) {
  return (await locations(cwd, home))?.version;
}

export async function managedLspServer(cwd: string, home = os.homedir()): Promise<string | undefined> {
  if (process.platform === 'win32') return;
  try {
    const dirs = await locations(cwd, home);
    if (!dirs || !await privateDir(dirs.root) || !await privateDir(dirs.version)) return;
    const server = await resolveLspServer(serverPath(dirs.version), cwd);
    return server && isWithin(dirs.version, server) ? server : undefined;
  } catch { return undefined; }
}

export async function findLspExecutable(name: 'npm' | 'typescript-language-server', cwd: string): Promise<string | undefined> {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const found = await resolveLspServer(path.join(dir, name), cwd);
    if (found) return found;
  }
}

/** Invoke only after the UI has confirmed the fixed package list and destination. */
export async function installTypeScriptLsp(cwd: string, npm: string, signal: AbortSignal, expectedDestination: string, home = os.homedir()): Promise<string> {
  signal.throwIfAborted();
  if (process.platform === 'win32') throw new Error('Managed LSP install is available on macOS and Linux');
  const dirs = await locations(cwd, home);
  if (!dirs || dirs.version !== expectedDestination || await resolveLspServer(npm, cwd) !== npm) throw new Error('LSP install location or npm changed');
  await fs.mkdir(dirs.root, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
  if (!await privateDir(dirs.root)) throw new Error('Unsafe Bi LSP data folder');
  const already = await managedLspServer(cwd, home);
  if (already) return already;
  const stage = await fs.mkdtemp(path.join(dirs.root, '.install-'));
  try {
    const packages = path.join(stage, 'packages');
    await fs.mkdir(packages, { mode: 0o700 });
    await fs.writeFile(path.join(packages, 'package.json'), '{"private":true}\n', { flag: 'wx' });
    const userConfig = path.join(stage, 'user.npmrc');
    const globalConfig = path.join(stage, 'global.npmrc');
    await Promise.all([fs.writeFile(userConfig, '', { flag: 'wx' }), fs.writeFile(globalConfig, '', { flag: 'wx' })]);
    // Do not inherit npm credentials, config, proxies, NODE_OPTIONS, or project settings.
    signal.throwIfAborted();
    await run(npm, ['install', ...lspPackages, '--prefix', packages, '--ignore-scripts', '--no-audit', '--no-fund',
      '--save-exact', '--workspaces=false', '--global=false', `--registry=${registry}`,
      `--userconfig=${userConfig}`, `--globalconfig=${globalConfig}`, `--cache=${path.join(stage, 'cache')}`], {
      cwd: packages, env: { PATH: `${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin`, HOME: stage },
      timeout: 120_000, signal, killSignal: 'SIGKILL', maxBuffer: 512 * 1024,
    });
    signal.throwIfAborted();
    const executable = await resolveLspServer(serverPath(packages), cwd);
    if (!executable || !isWithin(packages, executable) || !await privateDir(dirs.root)) throw new Error('Installed LSP executable is missing or unsafe');
    const existing = await fs.lstat(dirs.version).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    if (existing) {
      const installed = await managedLspServer(cwd, home);
      if (installed) return installed;
      throw new Error('Refusing to overwrite the existing LSP install folder');
    }
    signal.throwIfAborted();
    await fs.rename(packages, dirs.version);
    const installed = await managedLspServer(cwd, home);
    if (!installed) throw new Error('Could not verify the installed language server');
    return installed;
  } finally {
    if (await privateDir(dirs.root) && await privateDir(stage)) await fs.rm(stage, { recursive: true, force: true });
  }
}
