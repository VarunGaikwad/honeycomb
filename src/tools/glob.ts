import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isProtectedWrite, isWithin } from '../extension/permission-modes/paths.ts';
import { decidePermission } from '../extension/permission-modes/policy.ts';
import { loadPermissionRules } from '../extension/permission-modes/rules.ts';
import { literal } from '../tui/text.ts';
import type { Args, Tool } from '../types/index.ts';

const MAX_PATTERN = 256;
const MAX_ENTRIES = 20_000;
const MAX_MATCHES = 200;

function validPattern(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PATTERN &&
    !/[\\:[\]{}()!\p{Cc}]/u.test(value) && value.split('/').every(part =>
      part && part !== '.' && part !== '..' && (!part.includes('**') || part === '**'));
}

function excluded(workspace: string, target: string): boolean {
  return isProtectedWrite(target) || path.relative(workspace, target).split(path.sep)
    .some(part => ['.pi', '.bi'].includes(part.toLowerCase()));
}

export function createGlobTool(): Tool<Args> {
  return {
    name: 'glob',
    description: 'List workspace files by relative path pattern (*, ?, **). Skips symlinks and protected paths.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['pattern'],
      properties: {
        pattern: { type: 'string', minLength: 1, maxLength: MAX_PATTERN },
        path: { type: 'string', minLength: 1, description: 'Optional workspace search directory' },
      },
    },
    validate: (args): args is Args => !!args && typeof args === 'object' && !Array.isArray(args) &&
      Object.keys(args).every(key => key === 'pattern' || key === 'path') && validPattern((args as Args).pattern) &&
      ((args as Args).path === undefined || (typeof (args as Args).path === 'string' && !!(args as Args).path)),
    async execute(args, ctx) {
      const pattern = args.pattern as string;
      const lexicalWorkspace = path.resolve(ctx.workingDirectory);
      const requested = path.resolve(lexicalWorkspace, args.path as string ?? '.');
      if (!isWithin(lexicalWorkspace, requested) || excluded(lexicalWorkspace, requested)) {
        return { success: false, error: 'Glob requires a non-protected search root inside the workspace' };
      }
      const workspace = await fs.realpath(lexicalWorkspace);
      const root = path.join(workspace, path.relative(lexicalWorkspace, requested));
      if (excluded(workspace, root) || await fs.realpath(root) !== root) {
        return { success: false, error: 'Glob cannot search protected or symlinked directories' };
      }
      const config = loadPermissionRules(ctx.workingDirectory, () => {});
      if (config.invalid || decidePermission('default', 'glob', { pattern, path: requested }, ctx.workingDirectory, config.rules).action === 'deny') {
        return { success: false, error: 'Glob search denied by permission rules' };
      }
      const filterRules = !!(config.rules.deny?.length || config.rules.ask?.length);
      const matches: string[] = [];
      const pending = [root];
      let scanned = 0;
      let limited = false;
      while (pending.length && !limited) {
        ctx.signal?.throwIfAborted();
        const dir = pending.pop()!;
        if (await fs.realpath(dir) !== dir) continue;
        for await (const entry of await fs.opendir(dir)) {
          ctx.signal?.throwIfAborted();
          if (scanned++ === MAX_ENTRIES) { limited = true; break; }
          const full = path.join(dir, entry.name);
          if (entry.isSymbolicLink() || excluded(workspace, full)) continue;
          const relative = path.relative(root, full).split(path.sep).join('/');
          if (!entry.isDirectory() && (!entry.isFile() || !path.posix.matchesGlob(relative, pattern))) continue;
          // A search-root approval is not approval to disclose a separately restricted child.
          if (filterRules && decidePermission('default', 'glob', { pattern, path: full }, ctx.workingDirectory, config.rules).action !== 'allow') continue;
          if (entry.isDirectory()) pending.push(full);
          else matches.push(relative);
          if (matches.length >= MAX_MATCHES) { limited = true; break; }
        }
      }
      const output = matches.sort().map(name => literal(name)).join('\n');
      return { success: true, output: limited ? `${output}${output ? '\n' : ''}... Glob reached its scan or match limit.` : output };
    },
  };
}
