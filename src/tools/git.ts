import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { BI_CONFIG } from '../config/index.ts';
import { isProtectedWrite, resolvePermissionPath } from '../extension/permission-modes/paths.ts';
import type { Args, Tool, ToolContext, ToolResult } from '../types/index.ts';

const execFileAsync = promisify(execFile);
// Read operations must not refresh the on-disk index or invoke repo-configured helpers.
const readOnlyFlags = ['--no-optional-locks', '--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false'];

export async function disableWorktreeFilters(context: ToolContext, timeout = 30_000, env?: NodeJS.ProcessEnv): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', [...readOnlyFlags, 'config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'], {
      cwd: context.workingDirectory, signal: context.signal, timeout, env,
    });
    return [...new Set(stdout.split('\0').filter(Boolean))].flatMap(key => {
      if (!/^filter\.[^=\r\n]+\.(clean|smudge|process|required)$/.test(key)) throw new Error('Invalid Git filter key');
      return ['-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`];
    });
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return [];
    throw error;
  }
}

export async function readGitStatus(context: ToolContext, args: string[], timeout = 30_000): Promise<ToolResult> {
  return runGit(context, [...readOnlyFlags, ...await disableWorktreeFilters(context, timeout), 'status', ...args, '--ignore-submodules=all'], timeout);
}

/** Git tools use execFile (never a shell) and run only in the active directory. */
export function createGitTools(options: { defaultLogLimit?: number } = {}): Tool<Args>[] {
  const defaultLogLimit = options.defaultLogLimit ?? BI_CONFIG.git.defaultLogLimit;
  if (!Number.isInteger(defaultLogLimit) || defaultLogLimit < 1 || defaultLogLimit > 100) {
    throw new Error('git.defaultLogLimit must be an integer from 1 to 100');
  }
  return [
    gitTool('git_status', 'Show working tree status', {}, async (_a, c) =>
      readGitStatus(c, ['--short', '--branch'])),
    gitTool('git_diff', 'Show working tree diff', { staged: 'boolean?' }, async (a, c) =>
      runDiff(c, a.staged === true)),
    gitTool('git_log', 'Show recent commit history; the default limit comes from configuration.', { limit: 'number?' }, async (a, c) => {
      const limit = a.limit === undefined
        ? c.projectConfig?.git?.defaultLogLimit ?? defaultLogLimit
        : a.limit as number;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return { success: false, error: 'limit must be an integer from 1 to 100' };
      }
      return runGit(c, [...readOnlyFlags, 'log', `-${limit}`, '--oneline', '--decorate']);
    }),
    gitTool('git_commit', 'Create a commit from staged changes', { message: 'string' }, async (a, c) => {
      const message = a.message as string;
      if (!message.trim()) return { success: false, error: 'Commit message must not be empty' };
      if (!await approve(c, 'git commit', message)) return { success: false, error: 'Commit was not approved' };
      return runGit(c, ['commit', '-m', message]);
    }),
    gitTool('git_branch', 'List branches or create a branch', { name: 'string?' }, async (a, c) => {
      if (typeof a.name !== 'string') return runGit(c, [...readOnlyFlags, 'branch', '--list']);
      if (!validRef(a.name)) return { success: false, error: 'Invalid branch name' };
      if (!await approve(c, 'create git branch', a.name)) return { success: false, error: 'Branch creation was not approved' };
      return runGit(c, ['branch', '--', a.name]);
    }),
    gitTool('git_checkout', 'Switch to an existing branch', { branch: 'string' }, async (a, c) => {
      const branch = a.branch as string;
      if (!validRef(branch)) return { success: false, error: 'Invalid branch name' };
      if (!await approve(c, 'git checkout', branch)) return { success: false, error: 'Checkout was not approved' };
      return runGit(c, ['checkout', branch]);
    }),
    gitTool('git_add', 'Stage paths for commit', { paths: 'array' }, async (a, c) => {
      const paths = a.paths as string[];
      if (!paths.length || paths.some((p) => !p || p.includes('\0'))) {
        return { success: false, error: 'paths must contain at least one valid path' };
      }
      if (!await approve(c, 'git add', paths.join(', '))) return { success: false, error: 'Staging was not approved' };
      return runGit(c, ['add', '--', ...paths]);
    }),
  ];
}

export async function runDiff(context: ToolContext, staged: boolean, selection?: { list: true } | { paths: string[] }): Promise<ToolResult> {
  try {
    const options = { cwd: context.workingDirectory, env: { ...process.env, GIT_NO_LAZY_FETCH: '1' }, encoding: 'utf8' as const, timeout: 30_000, maxBuffer: 10 * 1024 * 1024, signal: context.signal };
    const rootOutput = await execFileAsync('git', [...readOnlyFlags, 'rev-parse', '--show-toplevel'], options);
    const root = rootOutput.stdout.replace(/\n$/, '');
    const filters = staged ? [] : await disableWorktreeFilters(context);
    const listing = selection && 'list' in selection;
    const paths = selection && 'paths' in selection ? selection.paths : [];
    const args = [...readOnlyFlags, ...filters, '--literal-pathspecs', '-C', root, 'diff', '--raw', '-z', ...(listing ? [] : ['--patch']), '--no-color', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', ...(staged ? ['--cached'] : []), '--', ...paths];
    const { stdout, stderr } = await execFileAsync('git', args, options);
    if (!stdout) return listing ? { success: true, metadata: { files: [], root } } : { success: true, output: stderr.trimEnd() };

    let cursor = 0;
    let sensitive = false;
    const files: { status: string; paths: string[] }[] = [];
    try {
      while (cursor < stdout.length && stdout[cursor] !== '\0') {
        const end = stdout.indexOf('\0', cursor);
        if (end < 0) throw new Error('Cannot identify diff paths');
        const header = stdout.slice(cursor, end);
        const match = /^:\d{6} \d{6} [0-9a-f]+ [0-9a-f]+ ([ACDMRTUXB])\d*$/.exec(header);
        if (!match) throw new Error('Cannot identify diff paths');
        cursor = end + 1;
        const count = match[1] === 'R' || match[1] === 'C' ? 2 : 1;
        const names: string[] = [];
        for (let i = 0; i < count; i++) {
          const pathEnd = stdout.indexOf('\0', cursor);
          if (pathEnd < 0 || pathEnd === cursor) throw new Error('Cannot identify diff paths');
          const name = stdout.slice(cursor, pathEnd);
          if (selection && name.includes('\uFFFD')) throw new Error('Unsupported Git filename encoding');
          names.push(name);
          const target = path.resolve(root, name);
          try {
            if (isProtectedWrite(target) || isProtectedWrite(resolvePermissionPath(root, target))) sensitive = true;
          } catch { sensitive = true; }
          cursor = pathEnd + 1;
        }
        files.push({ status: match[1]!, paths: names });
      }
      if (listing ? cursor !== stdout.length : stdout[cursor] !== '\0') throw new Error('Cannot identify diff paths');
    } catch {
      if (listing || selection) throw new Error('Cannot safely classify diff paths');
      sensitive = true;
      const separator = stdout.indexOf('\0\0');
      if (separator < 0) throw new Error('Cannot safely separate diff output');
      cursor = separator + 1;
    }
    if (sensitive && !await context.confirmSensitiveRead?.('The diff contains sensitive paths or its paths could not be classified.')) {
      return { success: false, error: 'Sensitive diff was not approved' };
    }
    if (listing) return { success: true, metadata: { files, root } };
    return { success: true, output: [stdout.slice(cursor + 1).trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n') };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Unable to inspect Git diff: ${message}` };
  }
}

async function runGit(context: ToolContext, args: string[], timeout = 30_000): Promise<ToolResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd: context.workingDirectory,
      ...(args[0] === '--no-optional-locks' ? { env: { ...process.env, GIT_NO_LAZY_FETCH: '1' } } : {}),
      encoding: 'utf8',
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      signal: context.signal,
    });
    return { success: true, output: [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n') };
  } catch (error) {
    const e = error as Error & { stdout?: string; stderr?: string; code?: number | string };
    return {
      success: false,
      output: [e.stdout, e.stderr].filter(Boolean).join('\n'),
      error: e.message,
      metadata: { exitCode: e.code },
    };
  }
}

async function approve(context: ToolContext, operation: string, target: string): Promise<boolean> {
  return !!context.confirmDestructive && context.confirmDestructive(operation, target);
}

function validRef(value: string): boolean {
  return value.length > 0 && !value.startsWith('-') && !value.includes('\0');
}

function gitTool(
  name: string,
  description: string,
  shape: Record<string, string>,
  execute: (args: Args, context: ToolContext) => Promise<ToolResult>,
): Tool<Args> {
  return {
    name,
    description,
    parameters: {
      type: 'object',
      properties: Object.fromEntries(Object.entries(shape).map(([key, type]) => [
        key,
        type === 'array' ? { type: 'array', items: { type: 'string' } } : { type: type.replace('?', '') },
      ])),
      required: Object.entries(shape).filter(([, type]) => !type.endsWith('?')).map(([key]) => key),
      additionalProperties: false,
    },
    validate: (value): value is Args => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
      const args = value as Args;
      return Object.entries(shape).every(([key, type]) =>
        (type.endsWith('?') && args[key] === undefined) ||
        (type === 'array' ? Array.isArray(args[key]) && (args[key] as unknown[]).every((v) => typeof v === 'string') :
          typeof args[key] === type.replace('?', '')));
    },
    execute,
  };
}
