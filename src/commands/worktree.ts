import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { devNull } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { PermissionController } from '../extension/permission-modes/index.ts';
import { isProtectedWrite } from '../extension/permission-modes/paths.ts';
import { disableWorktreeFilters } from '../tools/git.ts';
import { literal } from '../tui/text.ts';

const exec = promisify(execFile);
const timeout = 30_000;
const flags = ['--no-pager', '--no-optional-locks', '-c', `core.hooksPath=${devNull}`, '-c', 'core.fsmonitor=false',
  '-c', 'core.untrackedCache=false', '-c', 'submodule.recurse=false'];
const usage = 'Usage: /worktree [list | create <directory-name> | leave]';

function parseWorktrees(output: string) {
  const rows = output.split('\0\0').filter(Boolean).map(record => {
    const [first, ...fields] = record.split('\0');
    if (!first?.startsWith('worktree ')) throw new Error('Unexpected Git worktree listing');
    return { directory: first.slice(9), fields };
  });
  if (!rows.length) throw new Error('No Git worktrees found');
  return rows;
}

export function registerWorktreeCommand(pi: ExtensionAPI, permissions: PermissionController): void {
  let busy = false;
  pi.registerCommand('worktree', {
    description: 'List or create Git worktrees, or find the way back to the main checkout',
    async handler(args, ctx) {
      if (!ctx.hasUI) return;
      const idle = () => ctx.isIdle() && !ctx.hasPendingMessages();
      if (ctx.mode !== 'tui' || busy || !idle()) return ctx.ui.notify('Use /worktree in an idle terminal session.', 'warning');
      const input = args.trim();
      const name = /^create\s+([a-zA-Z0-9][a-zA-Z0-9._-]{0,79})$/.exec(input)?.[1];
      if ((!name && !['', 'list', 'leave'].includes(input)) || name?.endsWith('.')) return ctx.ui.notify(usage, 'warning');
      const mode = permissions.mode;
      if (!ctx.isProjectTrusted() || (name && (mode === 'plan' || mode === 'dontAsk'))) {
        return ctx.ui.notify('Worktrees require a trusted workspace. Creation is unavailable in Plan and No prompts modes.', 'warning');
      }
      const sessionId = ctx.sessionManager.getSessionId();
      const leaf = ctx.sessionManager.getLeafId();
      const abort = new AbortController();
      const signal = ctx.signal ? AbortSignal.any([abort.signal, ctx.signal]) : abort.signal;
      const current = () => !signal.aborted && idle() && ctx.isProjectTrusted() && permissions.mode === mode &&
        ctx.sessionManager.getSessionId() === sessionId && ctx.sessionManager.getLeafId() === leaf;
      busy = true;
      const unsubscribe = permissions.subscribe(() => abort.abort());
      const notify = (message: string, level: 'info' | 'warning' = 'info') => { if (current()) ctx.ui.notify(message, level); };
      try {
        // Ignore inherited Git routing/config overrides and disallow transport even for partial clones.
        const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))),
          GIT_ALLOW_PROTOCOL: '', GIT_NO_LAZY_FETCH: '1' };
        const cwd = await realpath(ctx.cwd);
        const git = async (...args: string[]) => (await exec('git', [...flags, ...args], { cwd, env, signal, timeout, maxBuffer: 1024 * 1024 })).stdout;
        const root = async () => (await git('rev-parse', '--show-toplevel')).replace(/\r?\n$/, '');
        if (await root() !== cwd) return notify('Open Pi at the root of a Git worktree first.', 'warning');
        if (!current()) return;
        const context = { workingDirectory: cwd, sessionId, signal };
        const filters = () => disableWorktreeFilters(context, timeout, env);
        const worktrees = async () => parseWorktrees(await git('worktree', 'list', '--porcelain', '-z'));
        const commonDir = async (directory: string) => realpath((await git('-C', directory, 'rev-parse',
          '--path-format=absolute', '--git-common-dir')).replace(/\r?\n$/, ''));
        const dirty = async (overrides: string[]) => {
          const status = await git(...overrides, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=dirty');
          if (!status) return false;
          const records = status.slice(0, -1).split('\0');
          // Git reports an embedded checkout as one untracked directory. Ignore only exact matches.
          if (records.some(record => !record.startsWith('?? ') || !record.endsWith('/'))) return true;
          const nested = new Map<string, string>((await worktrees()).flatMap(({ directory, fields }) => {
            const relative = path.relative(cwd, directory).split(path.sep).join('/');
            return relative && relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative) &&
              !fields.some(field => field === 'bare' || field === 'prunable' || field.startsWith('prunable '))
              ? [[`?? ${relative}/`, directory] as const] : [];
          }));
          const shared = await commonDir(cwd);
          for (const record of records) {
            const directory = nested.get(record);
            if (!directory) return true;
            try {
              if (await realpath(directory) !== directory || !(await lstat(path.join(directory, '.git'))).isFile() ||
                  await commonDir(directory) !== shared) return true;
            } catch { return true; }
          }
          return false;
        };
        if (!name) {
          const rows = await worktrees();
          if (input !== 'leave') {
            const lines = rows.slice(0, 30).map(({ directory, fields }) => {
              const label = fields.find(field => field.startsWith('branch '))?.slice(7).replace(/^refs\/heads\//, '') ??
                (fields.includes('bare') ? 'bare' : `detached ${fields.find(field => field.startsWith('HEAD '))?.slice(5, 17) ?? ''}`.trim());
              return `${literal(directory)} — ${literal(label)}${directory === cwd ? ' (current)' : ''}`;
            });
            if (rows.length > lines.length) lines.push(`… ${rows.length - lines.length} more worktrees`);
            return notify(lines.join('\n'));
          }
          const main = rows[0]!;
          if (main.directory === cwd) return notify('This is already the main checkout. Nothing changed.');
          const changes = await dirty(await filters());
          const next = main.fields.includes('bare') ? 'The main repository is bare. Start a new Pi session in another checkout.' :
            `To leave, start a new Pi session at ${literal(main.directory)}.`;
          return notify(`${changes ? 'This checkout has local changes. ' : ''}${next}\nThis session and its worktree were left unchanged.`, changes ? 'warning' : 'info');
        }

        const destination = path.join(cwd, name);
        if (isProtectedWrite(destination) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
          return notify('Unsafe worktree directory name.', 'warning');
        }
        const missing = async () => lstat(destination).then(() => false, (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          return true;
        });
        const head = async () => (await git('rev-parse', '--verify', 'HEAD^{commit}')).trim();
        if (!await missing()) return notify('The worktree destination already exists.', 'warning');
        if (await dirty(await filters())) return notify('Commit, stash, or move local changes before creating a worktree.', 'warning');
        const commit = await head();
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit) || !current()) return;
        const accepted = await permissions.prompter.confirm(ctx, 'Create a Git worktree?',
          `Destination: ${literal(destination)}\nDetached HEAD: ${commit}\nThe current checkout and Pi working directory will not change.`, signal);
        if (!accepted || !current()) return;
        const overrides = await filters();
        if (await realpath(ctx.cwd) !== cwd || await root() !== cwd || await head() !== commit ||
            await dirty(overrides) || !await missing()) return notify('The checkout or destination changed after approval. Nothing was created.', 'warning');
        if (!current()) return;
        await git(...overrides, 'worktree', 'add', '--detach', '--', destination, commit);
        notify(`Created a worktree at ${literal(destination)}. Start a new Pi session there to use it; this session stayed put.`);
      } catch {
        notify('Git worktree operation failed. No automatic cleanup or removal was attempted.', 'warning');
      } finally {
        unsubscribe();
        busy = false;
      }
    },
  });
}
