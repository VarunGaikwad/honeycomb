import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { isProtectedWrite, isWithin } from '../extension/permission-modes/paths.ts';
import type { Args, Tool, ToolContext } from '../types/index.ts';
import { MAX_UNDO_FILE_BYTES, type UndoJournal } from './undo-journal.ts';

const MAX_SOURCE = 12_000;
const MAX_SOURCE_LINES = 80;
const fields = ['path', 'cell_index', 'old_source', 'new_source'] as const;
type NotebookArgs = Args & { path: string; cell_index: number; old_source: string; new_source: string };

export function validNotebookEdit(value: unknown): value is NotebookArgs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const args = value as NotebookArgs;
  const keys = Object.keys(args);
  return keys.length === fields.length && fields.every(key => Object.hasOwn(args, key)) &&
    typeof args.path === 'string' && args.path.endsWith('.ipynb') && !args.path.includes('\0') &&
    Number.isSafeInteger(args.cell_index) && args.cell_index >= 0 &&
    [args.old_source, args.new_source].every(s => typeof s === 'string' && s.length <= MAX_SOURCE && s.split('\n').length <= MAX_SOURCE_LINES) &&
    args.old_source !== args.new_source;
}

export function createNotebookTool(options: {
  journal: UndoJournal;
  readHash: (ctx: ToolContext, file: string) => string | undefined;
  atomicReplace: (file: string, bytes: Buffer, mode: number, validate: () => Promise<void>) => Promise<void>;
}): Tool<NotebookArgs> {
  return {
    name: 'notebook_edit',
    description: 'Replace an existing .ipynb cell source only. Read the notebook first and supply the exact full old source (join source arrays without separators) and a zero-based cell index. Does not run cells.',
    parameters: {
      type: 'object', additionalProperties: false, required: [...fields],
      properties: {
        path: { type: 'string', pattern: '\\.ipynb$' },
        cell_index: { type: 'integer', minimum: 0 },
        old_source: { type: 'string', maxLength: MAX_SOURCE }, new_source: { type: 'string', maxLength: MAX_SOURCE },
      },
    },
    validate: validNotebookEdit,
    async execute(args, ctx) {
      const resolve = async () => {
        const cwd = path.resolve(ctx.workingDirectory);
        const requested = path.resolve(cwd, args.path);
        if (!isWithin(cwd, requested) || isProtectedWrite(requested)) throw new Error('Unsafe notebook path');
        const root = await fs.realpath(cwd);
        const file = path.join(root, path.relative(cwd, requested));
        if (isProtectedWrite(file) || await fs.realpath(file) !== file) throw new Error('Unsafe or symlinked notebook path');
        return file;
      };
      const file = await resolve();
      const expected = options.readHash(ctx, file);
      if (!expected) return { success: false, error: 'Read the notebook in this session before editing it' };
      const before = await readNotebook(file);
      if (hash(before.bytes) !== expected) return { success: false, error: 'Notebook has changed since it was read' };
      const original = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(before.bytes);
      const offset = original.startsWith('\uFEFF') ? 1 : 0;
      const text = original.slice(offset);
      const updated = editSource(text, args);
      const bytes = Buffer.from(original.slice(0, offset) + updated);
      if (bytes.length > MAX_UNDO_FILE_BYTES) return { success: false, error: 'Updated notebook exceeds the 1 MiB edit limit' };
      if (!ctx.confirmDestructive || !await ctx.confirmDestructive('edit notebook cell', file)) {
        return { success: false, error: 'Notebook edit was not approved' };
      }
      ctx.signal?.throwIfAborted();
      await options.atomicReplace(file, bytes, before.mode, async () => {
        if (await resolve() !== file) throw new Error('Notebook path changed');
        const current = await readNotebook(file);
        if (!current.bytes.equals(before.bytes) || current.dev !== before.dev || current.ino !== before.ino || current.mode !== before.mode) {
          throw new Error('Notebook changed before the edit could be saved');
        }
        ctx.signal?.throwIfAborted();
        if (ctx.checkNotebookEdit?.() === false) throw new Error('Notebook edit permission changed before saving');
      });
      options.journal.record(ctx, [{ id: randomUUID(), file, before: before.bytes, afterHash: hash(bytes) }]);
      options.journal.invalidateSnapshots?.(ctx, [file]);
      return { success: true, output: `Updated source of cell ${args.cell_index}. No cells were executed.` };
    },
  };
}

function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readNotebook(file: string) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_UNDO_FILE_BYTES) throw new Error('Expected a regular unlinked notebook of at most 1 MiB');
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== stat.size) throw new Error('Notebook changed while reading');
    return { bytes: buffer.subarray(0, length), mode: stat.mode, dev: stat.dev, ino: stat.ino };
  } finally {
    await handle.close();
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function source(value: unknown): value is string | string[] {
  return typeof value === 'string' || (Array.isArray(value) && value.every(part => typeof part === 'string'));
}

function editSource(text: string, args: NotebookArgs): string {
  let book: unknown;
  try { book = JSON.parse(text); } catch { throw new Error('Notebook is not valid JSON'); }
  if (!record(book) || book.nbformat !== 4 || typeof book.nbformat_minor !== 'number' || !Number.isInteger(book.nbformat_minor) || book.nbformat_minor < 0 || !record(book.metadata) || !Array.isArray(book.cells) ||
      !book.cells.every(cell => record(cell) && record(cell.metadata) && source(cell.source) &&
        (cell.cell_type === 'markdown' || cell.cell_type === 'raw' || (cell.cell_type === 'code' && Array.isArray(cell.outputs) &&
          (cell.execution_count === null || Number.isInteger(cell.execution_count)))))) throw new Error('Expected a valid nbformat 4 notebook');
  const cell = book.cells[args.cell_index];
  if (!cell) throw new Error('Notebook cell index is out of range');
  if ((Array.isArray(cell.source) ? cell.source.join('') : cell.source) !== args.old_source) throw new Error('Cell source does not match old_source');

  // Walk tokens of already-validated JSON to locate just the source value.
  // Re-serializing the document could change unrelated formatting or numbers.
  const tokens = /"(?:[^"\\]|\\[\s\S])*"|[{}[\],:]|[^\s{}[\],:]+/gy;
  let cursor = 0;
  const next = () => {
    while (cursor < text.length && /[\t\n\r ]/.test(text[cursor]!)) cursor++;
    const start = cursor;
    tokens.lastIndex = start;
    const match = tokens.exec(text);
    if (!match) throw new Error('Unexpected notebook token');
    cursor = tokens.lastIndex;
    return { start, value: match[0] };
  };
  const skip = (first: string) => {
    let depth = first === '[' || first === '{' ? 1 : 0;
    while (depth) {
      const { value } = next();
      if (value === '[' || value === '{') depth++;
      if (value === ']' || value === '}') depth--;
    }
  };
  const member = (key: string) => {
    let span: { start: number; end: number } | undefined;
    for (let name = next(); name.value !== '}'; name = next()) {
      next(); // colon
      const first = next();
      skip(first.value);
      if (JSON.parse(name.value) === key) {
        if (span) throw new Error(`Notebook contains duplicate ${key} fields`);
        span = { start: first.start, end: cursor };
      }
      if (next().value === '}') break;
    }
    if (!span) throw new Error(`Notebook is missing ${key}`);
    return span;
  };
  next(); // root object
  const cells = member('cells');
  cursor = cells.start;
  next(); // cells array
  for (let index = 0; index < args.cell_index; index++) { skip(next().value); next(); }
  next(); // selected cell object
  const span = member('source');
  const replacement = Array.isArray(cell.source) ? args.new_source.match(/[^\n]*\n|[^\n]+$/g) ?? [] : args.new_source;
  return text.slice(0, span.start) + JSON.stringify(replacement) + text.slice(span.end);
}
