import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Args, Tool, ToolContext, ToolResult } from '../types/index.ts';

const execFileAsync = promisify(execFile);

/** Git tools use execFile (never a shell) and run only in the active directory. */
export function createGitTools(): Tool<Args>[] {
  return [
    gitTool('git_status', 'Show working tree status', {}, async (_a, c) =>
      runGit(c, ['status', '--short', '--branch'])),
    gitTool('git_diff', 'Show working tree diff', { staged: 'boolean?' }, async (a, c) =>
      runGit(c, a.staged === true ? ['diff', '--cached'] : ['diff'])),
    gitTool('git_log', 'Show recent commit history', { limit: 'number?' }, async (a, c) => {
      const limit = a.limit === undefined ? 10 : a.limit as number;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return { success: false, error: 'limit must be an integer from 1 to 100' };
      }
      return runGit(c, ['log', `-${limit}`, '--oneline', '--decorate']);
    }),
    gitTool('git_commit', 'Create a commit from staged changes', { message: 'string' }, async (a, c) => {
      const message = a.message as string;
      if (!message.trim()) return { success: false, error: 'Commit message must not be empty' };
      if (!await approve(c, 'git commit', message)) return { success: false, error: 'Commit was not approved' };
      return runGit(c, ['commit', '-m', message]);
    }),
    gitTool('git_branch', 'List branches or create a branch', { name: 'string?' }, async (a, c) => {
      if (typeof a.name !== 'string') return runGit(c, ['branch', '--list']);
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

async function runGit(context: ToolContext, args: string[]): Promise<ToolResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd: context.workingDirectory,
      encoding: 'utf8',
      timeout: 30_000,
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
