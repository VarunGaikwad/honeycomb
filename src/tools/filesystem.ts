import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Tool, ToolContext } from './types.ts';

type Args = Record<string, unknown>;

/**
 * Creates the Phase 2 filesystem tools. All paths are relative to the active
 * working directory, and resolved paths (including symlinks) must stay inside it.
 */
export function createFileSystemTools(): Tool<Args>[] {
  return [
    tool('read', 'Read a UTF-8 text file', { path: 'string' }, async (a, c) =>
      ({ success: true, output: await fs.readFile(await resolvePath(c, stringArg(a, 'path')), 'utf8') })),
    tool('write', 'Create or overwrite a UTF-8 text file', { path: 'string', content: 'string' }, async (a, c) => {
      const file = await resolvePath(c, stringArg(a, 'path'), true);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, stringArg(a, 'content'), 'utf8');
      return { success: true, output: `Wrote ${file}` };
    }),
    tool('edit', 'Replace one exact text occurrence in a file', { path: 'string', oldText: 'string', newText: 'string' }, async (a, c) => {
      const file = await resolvePath(c, stringArg(a, 'path'));
      const content = await fs.readFile(file, 'utf8');
      const oldText = stringArg(a, 'oldText');
      const first = content.indexOf(oldText);
      if (first < 0) return { success: false, error: 'Text to replace was not found' };
      if (content.indexOf(oldText, first + oldText.length) >= 0) {
        return { success: false, error: 'Text occurs more than once; edit requires a unique match' };
      }
      await fs.writeFile(file, content.slice(0, first) + stringArg(a, 'newText') + content.slice(first + oldText.length), 'utf8');
      return { success: true, output: `Edited ${file}` };
    }),
    tool('ls', 'List directory entries', { path: 'string?' }, async (a, c) => {
      const dir = await resolvePath(c, optionalString(a, 'path') ?? '.');
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return { success: true, output: entries.map((e) => `${e.isDirectory() ? 'dir' : 'file'} ${e.name}`).join('\n') };
    }),
    tool('find', 'Find files and directories by name substring', { path: 'string?', name: 'string' }, async (a, c) => {
      const root = await resolvePath(c, optionalString(a, 'path') ?? '.');
      const name = stringArg(a, 'name');
      const matches: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.name.includes(name)) matches.push(path.relative(root, full));
          if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(full);
        }
      };
      await walk(root);
      return { success: true, output: matches.join('\n') };
    }),
    tool('grep', 'Search text files for a literal string', { path: 'string?', query: 'string' }, async (a, c) => {
      const root = await resolvePath(c, optionalString(a, 'path') ?? '.');
      const query = stringArg(a, 'query');
      const matches: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(full);
          else if (entry.isFile()) {
            try {
              const text = await fs.readFile(full, 'utf8');
              text.split('\n').forEach((line, i) => {
                if (line.includes(query)) matches.push(`${path.relative(root, full)}:${i + 1}:${line}`);
              });
            } catch { /* Ignore files that are not readable text. */ }
          }
        }
      };
      await walk(root);
      return { success: true, output: matches.join('\n') };
    }),
    tool('mkdir', 'Create a directory', { path: 'string' }, async (a, c) => {
      const dir = await resolvePath(c, stringArg(a, 'path'), true);
      await fs.mkdir(dir, { recursive: true });
      return { success: true, output: `Created ${dir}` };
    }),
    tool('delete', 'Delete a file or directory (requires approval)', { path: 'string' }, async (a, c) => {
      const target = await resolvePath(c, stringArg(a, 'path'));
      if (!c.confirmDestructive || !(await c.confirmDestructive('delete', target))) {
        return { success: false, error: 'Deletion was not approved' };
      }
      await fs.rm(target, { recursive: true, force: false });
      return { success: true, output: `Deleted ${target}` };
    }),
    tool('move', 'Move or rename a file or directory', { source: 'string', destination: 'string' }, async (a, c) => {
      const source = await resolvePath(c, stringArg(a, 'source'));
      const destination = await resolvePath(c, stringArg(a, 'destination'), true);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.rename(source, destination);
      return { success: true, output: `Moved ${source} to ${destination}` };
    }),
    tool('copy', 'Copy a file or directory', { source: 'string', destination: 'string' }, async (a, c) => {
      const source = await resolvePath(c, stringArg(a, 'source'));
      const destination = await resolvePath(c, stringArg(a, 'destination'), true);
      await fs.cp(source, destination, { recursive: true, errorOnExist: true, force: false });
      return { success: true, output: `Copied ${source} to ${destination}` };
    }),
  ];
}

function tool(
  name: string,
  description: string,
  shape: Record<string, string>,
  execute: (args: Args, context: ToolContext) => Promise<{ success: boolean; output?: string; error?: string }>,
): Tool<Args> {
  return {
    name, description,
    parameters: {
      type: 'object',
      properties: Object.fromEntries(Object.entries(shape).map(([key, type]) => [key, { type: type.replace('?', '') }])),
      required: Object.entries(shape).filter(([, type]) => !type.endsWith('?')).map(([key]) => key),
      additionalProperties: false,
    },
    validate: (args): args is Args => isRecord(args) && Object.entries(shape).every(([key, type]) =>
      (type.endsWith('?') && args[key] === undefined) || typeof args[key] === type.replace('?', '')),
    execute,
  };
}

function isRecord(value: unknown): value is Args {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringArg(args: Args, key: string): string {
  if (typeof args[key] !== 'string') throw new TypeError(`"${key}" must be a string`);
  return args[key] as string;
}

function optionalString(args: Args, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new TypeError(`"${key}" must be a string`);
  return value;
}

async function resolvePath(context: ToolContext, input: string, allowMissing = false): Promise<string> {
  const root = await fs.realpath(context.workingDirectory);
  const candidate = path.resolve(root, input);
  if (!inside(root, candidate)) throw new Error('Path is outside the working directory');
  let resolved: string;
  try {
    resolved = await fs.realpath(candidate);
  } catch (error) {
    if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = await fs.realpath(path.dirname(candidate));
    if (!inside(root, parent)) throw new Error('Path is outside the working directory');
    resolved = path.join(parent, path.basename(candidate));
  }
  if (!inside(root, resolved)) throw new Error('Path is outside the working directory');
  return resolved;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
