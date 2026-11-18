import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Args, Tool, ToolContext, ToolResult } from '../types/index.ts';

/** Persistent project-local memory and checkpoints, with optional host delegation. */
export function createAdvancedTools(): Tool<Args>[] {
  return [
    makeTool('memory', 'Read, write, or append project-local agent memory', {
      action: 'string', content: 'string?',
    }, async (a, c) => {
      const file = await stateFile(c, 'memory.json');
      const data = await readJson(file, { entries: [] as string[] });
      if (a.action === 'read') return { success: true, output: data.entries.join('\n') };
      if (a.action !== 'write' && a.action !== 'append') return { success: false, error: 'action must be read, write, or append' };
      if (typeof a.content !== 'string') return { success: false, error: 'content is required' };
      data.entries = a.action === 'write' ? [a.content] : [...data.entries, a.content];
      await writeJson(file, data);
      return { success: true, output: `Memory ${a.action} complete` };
    }),
    makeTool('checkpoint', 'Create or list file-content recovery checkpoints', {
      action: 'string', label: 'string?', paths: 'array?',
    }, async (a, c) => {
      const dir = await stateDir(c, 'checkpoints');
      await fs.mkdir(dir, { recursive: true });
      if (a.action === 'list') {
        const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json')).sort();
        const checkpoints = await Promise.all(files.map((f) => readJson(path.join(dir, f), null)));
        return { success: true, output: checkpoints.map((p: any) => `${p.id} ${p.label} (${p.files.length} files)`).join('\n') };
      }
      if (a.action !== 'create') return { success: false, error: 'action must be create or list' };
      const targets = Array.isArray(a.paths) ? a.paths as string[] : [];
      if (!targets.length) return { success: false, error: 'paths must contain files to capture' };
      const files: Array<{ path: string; content: string }> = [];
      for (const input of targets) {
        const file = await safeFile(c, input);
        const stat = await fs.stat(file);
        if (!stat.isFile()) return { success: false, error: `${input} is not a file` };
        files.push({ path: path.relative(c.workingDirectory, file), content: (await fs.readFile(file)).toString('base64') });
      }
      const checkpoint = {
        id: randomUUID(),
        label: typeof a.label === 'string' ? a.label : 'checkpoint',
        createdAt: new Date().toISOString(),
        files,
      };
      await writeJson(path.join(dir, `${checkpoint.id}.json`), checkpoint);
      return { success: true, output: checkpoint.id, metadata: { fileCount: files.length } };
    }),
    makeTool('subagent', 'Delegate a task to a host-provided specialized agent', {
      task: 'string',
    }, async (a, c) => {
      if (!c.delegateAgent) return { success: false, error: 'Agent delegation is unavailable in this context' };
      return { success: true, output: await c.delegateAgent(a.task as string) };
    }),
  ];
}

function makeTool(
  name: string,
  description: string,
  shape: Record<string, string>,
  execute: (args: Args, context: ToolContext) => Promise<ToolResult>,
): Tool<Args> {
  return {
    name, description,
    parameters: {
      type: 'object',
      properties: Object.fromEntries(Object.entries(shape).map(([k, type]) => [
        k, type.startsWith('array') ? { type: 'array', items: { type: 'string' } } : { type: type.replace('?', '') },
      ])),
      required: Object.entries(shape).filter(([, type]) => !type.endsWith('?')).map(([k]) => k),
      additionalProperties: false,
    },
    validate: (value): value is Args => value !== null && typeof value === 'object' && !Array.isArray(value) &&
      Object.entries(shape).every(([k, type]) => {
        const v = (value as Args)[k];
        return (type.endsWith('?') && v === undefined) ||
          (type.startsWith('array') ? Array.isArray(v) && v.every((item) => typeof item === 'string') :
            typeof v === type.replace('?', ''));
      }),
    execute,
  };
}

async function stateDir(context: ToolContext, name: string): Promise<string> {
  const root = await fs.realpath(context.workingDirectory);
  const dir = path.join(root, '.pi', name);
  const rel = path.relative(root, dir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Invalid state directory');
  return dir;
}

async function stateFile(context: ToolContext, name: string): Promise<string> {
  const dir = await stateDir(context, '');
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, name);
}

async function safeFile(context: ToolContext, input: string): Promise<string> {
  const root = await fs.realpath(context.workingDirectory);
  const target = path.resolve(root, input);
  const rel = path.relative(root, target);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('Path is outside the working directory');
  const real = await fs.realpath(target);
  const realRel = path.relative(root, real);
  if (realRel === '..' || realRel.startsWith(`..${path.sep}`) || path.isAbsolute(realRel)) throw new Error('Path is outside the working directory');
  return real;
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}
