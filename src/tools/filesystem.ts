import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MAX_UNDO_FILE_BYTES, type UndoJournal } from './undo-journal.ts';
import { writeUnlinkedFile } from './write-file.ts';
import { createGlobTool } from './glob.ts';
import { createNotebookTool } from './notebook.ts';
import { BI_CONFIG } from '../config/index.ts';
import { CONFIG_LIMITS } from '../config/limits.ts';
import type { Args, Tool, ToolContext } from '../types/index.ts';

const READ_LINE_TRUNCATION_MARKER = '... [truncated]';

interface FileSnapshot {
  size: number;
  mtimeMs: number;
  sha256: string;
}

/**
 * Creates the Phase 2 filesystem tools. All paths are relative to the active
 * working directory, and resolved paths (including symlinks) must stay inside it.
 */
export function createFileSystemTools(options: {
  journal?: UndoJournal;
  defaultReadLimit?: number;
  maxReadLineLength?: number;
  maxGrepMatches?: number;
} = {}): Tool<Args>[] {
  const defaultReadLimit = options.defaultReadLimit ?? BI_CONFIG.filesystem.defaultReadLimit;
  const maxReadLineLength = options.maxReadLineLength ?? BI_CONFIG.filesystem.maxReadLineLength;
  const maxGrepMatches = options.maxGrepMatches ?? BI_CONFIG.filesystem.maxGrepMatches;
  if (!Number.isInteger(defaultReadLimit) || defaultReadLimit < 1 || defaultReadLimit > CONFIG_LIMITS.maxReadLimit) {
    throw new Error(`filesystem.defaultReadLimit must be an integer from 1 to ${CONFIG_LIMITS.maxReadLimit}`);
  }
  if (!Number.isInteger(maxReadLineLength) || maxReadLineLength < READ_LINE_TRUNCATION_MARKER.length ||
    maxReadLineLength > CONFIG_LIMITS.maxReadLineLength) {
    throw new Error(`filesystem.maxReadLineLength must be an integer from ${READ_LINE_TRUNCATION_MARKER.length} to ${CONFIG_LIMITS.maxReadLineLength}`);
  }
  if (!Number.isInteger(maxGrepMatches) || maxGrepMatches < 1 || maxGrepMatches > CONFIG_LIMITS.maxGrepMatches) {
    throw new Error(`filesystem.maxGrepMatches must be an integer from 1 to ${CONFIG_LIMITS.maxGrepMatches}`);
  }
  const snapshots = new Map<string, Map<string, FileSnapshot>>();
  if (options.journal) options.journal.invalidateSnapshots = (ctx, files) => {
    const saved = snapshots.get(ctx.sessionId);
    for (const file of files) saved?.delete(file);
  };
  return [
    tool('read', 'Read a UTF-8 text file by line range. offset is 1-indexed; the default limit and line truncation length come from configuration.', {
      path: 'string', offset: 'number?', limit: 'number?',
    }, async (a, c) => {
      const offset = a.offset === undefined ? 1 : a.offset as number;
      const limit = a.limit === undefined
        ? c.projectConfig?.filesystem?.defaultReadLimit ?? defaultReadLimit
        : a.limit as number;
      const lineLength = c.projectConfig?.filesystem?.maxReadLineLength ?? maxReadLineLength;
      if (!Number.isInteger(offset) || offset < 1) {
        return { success: false, error: 'read: "offset" must be a positive integer (1-indexed)' };
      }
      if (!Number.isInteger(limit) || limit < 1) {
        return { success: false, error: 'read: "limit" must be a positive integer' };
      }
      const file = await resolvePath(c, stringArg(a, 'path'));
      const bytes = await fs.readFile(file);
      const stat = await fs.stat(file);
      const sessionSnapshots = snapshotsForSession(snapshots, c);
      const text = bytes.toString('utf8');
      const lines = splitReadLines(text);
      const start = offset - 1;
      if (start >= lines.length && (lines.length > 0 || a.offset !== undefined)) {
        return { success: false, error: `read: offset ${offset} is beyond end of file (${lines.length} lines total)` };
      }
      const selected = lines.slice(start, start + limit);
      let output = selected.map((line) => `${truncateReadLine(line.text, lineLength)}${line.ending}`).join('');
      const end = start + selected.length;
      if (start > 0 || end < lines.length) {
        const separator = output.endsWith('\n') || output.endsWith('\r') ? '\n' : '\n\n';
        output += `${separator}Showing lines ${offset}-${end} of ${lines.length}...`;
      }
      sessionSnapshots.set(file, snapshot(stat, bytes));
      return { success: true, output };
    }),
    tool('write', 'Create or overwrite a UTF-8 text file', { path: 'string', content: 'string' }, async (a, c) => {
      const file = await resolvePath(c, stringArg(a, 'path'), true);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const content = stringArg(a, 'content');
      let before: Buffer | null | undefined;
      if (options.journal && Buffer.byteLength(content) <= MAX_UNDO_FILE_BYTES) {
        try {
          const stat = await fs.lstat(file);
          if (stat.isFile() && stat.nlink === 1 && stat.size <= MAX_UNDO_FILE_BYTES) before = await fs.readFile(file);
        } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') before = null; }
      }
      await writeUnlinkedFile(file, content);
      options.journal?.record(c, before === undefined || before?.includes(0) ? [] : [{
        id: randomUUID(), file, before, afterHash: sha256(Buffer.from(content)),
      }]);
      return { success: true, output: `Wrote ${file}` };
    }),
    createEditTool(snapshots, options.journal),
    ...(options.journal ? [createNotebookTool({
      journal: options.journal,
      readHash: (ctx, file) => snapshots.get(ctx.sessionId)?.get(file)?.sha256,
      atomicReplace,
    })] : []),
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
    createGlobTool(),
    tool('grep', 'Search text files for a literal string; results are capped by configuration.', { path: 'string?', query: 'string' }, async (a, c) => {
      const root = await resolvePath(c, optionalString(a, 'path') ?? '.');
      const query = stringArg(a, 'query');
      const maxMatches = c.projectConfig?.filesystem?.maxGrepMatches ?? maxGrepMatches;
      const matches: string[] = [];
      let limitReached = false;
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          if (limitReached) return;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(full);
          else if (entry.isFile()) {
            try {
              const text = await fs.readFile(full, 'utf8');
              const lines = text.split('\n');
              for (let index = 0; index < lines.length; index++) {
                if (!lines[index].includes(query)) continue;
                matches.push(`${path.relative(root, full)}:${index + 1}:${lines[index]}`);
                if (matches.length >= maxMatches) {
                  limitReached = true;
                  break;
                }
              }
            } catch { /* Ignore files that are not readable text. */ }
          }
        }
      };
      await walk(root);
      const output = matches.join('\n');
      return {
        success: true,
        output: limitReached ? `${output}\n... Search stopped at the configured limit of ${maxMatches} matches.` : output,
      };
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

function createEditTool(snapshots: Map<string, Map<string, FileSnapshot>>, journal?: UndoJournal): Tool<Args> {
  return {
    name: 'edit',
    description: 'Replace exact text in a file that was read in this session. Read the file first; edits fail if it has not been read or has changed since reading. old_str must be unique unless replace_all is true; add more context if it is ambiguous. Use replace_all for intentional renames and edits for multiple non-overlapping changes in one file. Each edit matches the original file content. In mixed-ending files, inserted newlines use the first newline style found; untouched line endings are preserved.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_str: { type: 'string' },
        new_str: { type: 'string' },
        replace_all: { type: 'boolean', default: false },
        edits: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              old_str: { type: 'string' },
              new_str: { type: 'string' },
              replace_all: { type: 'boolean', default: false },
            },
            required: ['old_str', 'new_str'],
            additionalProperties: false,
          },
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    validate: (args): args is Args => {
      if (!isRecord(args)) return false;
      const normalized = normalizeLegacyParams(args);
      if (!normalized.error) {
        Object.assign(args, normalized.args);
        delete args.oldText;
        delete args.newText;
      }
      return true;
    },
    execute: (args, context) => executeEdit(args, context, snapshots, journal),
  };
}

interface TextEdit {
  oldText: string;
  newText: string;
  replaceAll: boolean;
}

function normalizeLegacyParams(args: Args): { args: Args; error?: string } {
  const hasLegacy = Object.hasOwn(args, 'oldText') || Object.hasOwn(args, 'newText');
  if (!hasLegacy) return { args };
  if (Object.hasOwn(args, 'old_str') || Object.hasOwn(args, 'new_str')) {
    return { args, error: 'edit: do not mix legacy oldText/newText with old_str/new_str' };
  }
  const normalized: Args = { ...args, old_str: args.oldText, new_str: args.newText };
  delete normalized.oldText;
  delete normalized.newText;
  return { args: normalized };
}

async function executeEdit(
  input: Args,
  context: ToolContext,
  snapshots: Map<string, Map<string, FileSnapshot>>,
  journal?: UndoJournal,
) {
  const normalized = normalizeLegacyParams(input);
  if (normalized.error) return { success: false, error: normalized.error };
  const args = normalized.args;
  const inputPath = args.path;
  if (typeof inputPath !== 'string' || inputPath.length === 0) {
    return { success: false, error: 'edit: "path" must be a non-empty string' };
  }
  if (args.replace_all !== undefined && typeof args.replace_all !== 'boolean') {
    return { success: false, error: 'edit: "replace_all" must be a boolean' };
  }

  const hasSingle = Object.hasOwn(args, 'old_str') || Object.hasOwn(args, 'new_str');
  const hasEdits = Object.hasOwn(args, 'edits');
  if (hasSingle && hasEdits) {
    return { success: false, error: 'edit: provide either old_str/new_str or edits, not both' };
  }
  if (!hasSingle && !hasEdits) {
    return { success: false, error: 'edit: provide old_str/new_str or a non-empty edits array' };
  }

  let edits: TextEdit[];
  const defaultReplaceAll = args.replace_all === true;
  if (hasEdits) {
    if (!Array.isArray(args.edits)) return { success: false, error: 'edit: "edits" must be an array' };
    if (args.edits.length === 0) return { success: false, error: 'edit: "edits" must not be empty' };
    edits = [];
    for (let index = 0; index < args.edits.length; index++) {
      const item = args.edits[index];
      if (!isRecord(item)) return editFailure(index, 'must be an object');
      if (typeof item.old_str !== 'string' || typeof item.new_str !== 'string') {
        return editFailure(index, 'must include string "old_str" and "new_str" values');
      }
      if (item.replace_all !== undefined && typeof item.replace_all !== 'boolean') {
        return editFailure(index, '"replace_all" must be a boolean');
      }
      edits.push({
        oldText: item.old_str,
        newText: item.new_str,
        replaceAll: item.replace_all === undefined ? defaultReplaceAll : item.replace_all,
      });
    }
  } else {
    if (typeof args.old_str !== 'string' || typeof args.new_str !== 'string') {
      return { success: false, error: 'edit: old_str and new_str must both be strings' };
    }
    edits = [{ oldText: args.old_str, newText: args.new_str, replaceAll: defaultReplaceAll }];
  }

  let file: string;
  try {
    file = await resolvePath(context, inputPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { success: false, error: `edit: file not found: ${inputPath}` };
    }
    return { success: false, error: `edit: ${errorMessage(error)}` };
  }

  const sessionSnapshots = snapshotsForSession(snapshots, context);
  const previousSnapshot = sessionSnapshots.get(file);
  if (!previousSnapshot) {
    return { success: false, error: `edit: ${inputPath} has not been read in this session` };
  }

  let stat;
  let bytes: Buffer;
  try {
    stat = await fs.stat(file);
    if (!stat.isFile()) return { success: false, error: `edit: ${inputPath} is not a regular file` };
    bytes = await fs.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { success: false, error: `edit: file not found: ${inputPath}` };
    }
    return { success: false, error: `edit: cannot read ${inputPath}: ${errorMessage(error)}` };
  }

  if (stat.size !== previousSnapshot.size || stat.mtimeMs !== previousSnapshot.mtimeMs) {
    const currentHash = sha256(bytes);
    if (currentHash !== previousSnapshot.sha256) {
      return { success: false, error: `edit: ${inputPath} has changed since it was read` };
    }
    sessionSnapshots.set(file, snapshot(stat, bytes));
  }

  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const textBytes = hasBom ? bytes.subarray(3) : bytes;
  if (textBytes.includes(0)) return { success: false, error: `edit: ${inputPath} is a binary file` };
  let original: string;
  try {
    original = new TextDecoder('utf-8', { fatal: true }).decode(textBytes);
  } catch {
    return { success: false, error: `edit: ${inputPath} is not valid UTF-8` };
  }
  if (/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(original)) {
    return { success: false, error: `edit: ${inputPath} is a binary file` };
  }

  // For mixed-ending files, replacement snippets use the first newline sequence found.
  // The original content is never normalized, so all untouched line endings stay unchanged.
  const lineEnding = original.match(/\r\n|\n|\r/)?.[0] ?? '\n';
  const replacements: Array<{ editIndex: number; start: number; end: number; text: string }> = [];
  for (let index = 0; index < edits.length; index++) {
    const edit = edits[index];
    if (edit.oldText.length === 0) return editFailure(index, 'old_str must not be empty');
    if (edit.oldText === edit.newText) return editFailure(index, 'old_str and new_str must be different');
    const oldText = normalizeLineEndings(edit.oldText, lineEnding);
    const newText = normalizeLineEndings(edit.newText, lineEnding);
    if (oldText === newText) return editFailure(index, 'old_str and new_str must be different');
    const positions = findOccurrences(original, oldText);
    if (positions.length === 0) return editFailure(index, `old_str was not found in ${inputPath}`);
    if (positions.length > 1 && !edit.replaceAll) {
      const lineNumbers = positions.map((position) => lineNumberAt(original, position));
      return editFailure(index,
        `old_str matches ${positions.length} times on lines ${lineNumbers.join(', ')}; add more context or set replace_all to true`);
    }
    for (const start of edit.replaceAll ? positions : [positions[0]]) {
      replacements.push({ editIndex: index, start, end: start + oldText.length, text: newText });
    }
  }

  replacements.sort((a, b) => a.start - b.start || a.end - b.end);
  let previous = replacements[0];
  for (let index = 1; index < replacements.length; index++) {
    const current = replacements[index];
    if (current.start < previous.end) {
      return {
        success: false,
        error: `edit: edit ${previous.editIndex + 1} overlaps edit ${current.editIndex + 1}; edits must target non-overlapping original text`,
      };
    }
    if (current.end > previous.end) previous = current;
  }

  let updated = '';
  let cursor = 0;
  for (const replacement of replacements) {
    updated += original.slice(cursor, replacement.start) + replacement.text;
    cursor = replacement.end;
  }
  updated += original.slice(cursor);

  const outputBytes = Buffer.concat([hasBom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(updated, 'utf8')]);
  try {
    await atomicReplace(file, outputBytes, stat.mode);
  } catch (error) {
    return { success: false, error: `edit: could not write ${inputPath}: ${errorMessage(error)}` };
  }
  journal?.record(context, stat.nlink !== 1 || outputBytes.length > MAX_UNDO_FILE_BYTES ? [] : [{ id: randomUUID(), file, before: bytes, afterHash: sha256(outputBytes) }]);
  sessionSnapshots.set(file, snapshot(await fs.stat(file), outputBytes));

  const diff = unifiedDiff(original, updated, inputPath);
  return {
    success: true,
    output: `${replacements.length} replacement${replacements.length === 1 ? '' : 's'} in ${inputPath}\n${diff}`,
  };
}

function editFailure(index: number, reason: string) {
  return { success: false, error: `edit: edit ${index + 1} failed: ${reason}` };
}

function normalizeLineEndings(text: string, lineEnding: string): string {
  return text.replace(/\r\n|\r|\n/g, lineEnding);
}

function findOccurrences(text: string, needle: string): number[] {
  const positions: number[] = [];
  let position = 0;
  while ((position = text.indexOf(needle, position)) !== -1) {
    positions.push(position);
    position += needle.length;
  }
  return positions;
}

function lineNumberAt(text: string, position: number): number {
  let line = 1;
  for (let index = 0; index < position; index++) if (text[index] === '\n') line++;
  return line;
}

export async function atomicReplace(file: string, contents: Buffer, mode: number, validate?: () => Promise<void>): Promise<void> {
  const target = await fs.realpath(file);
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temp, 'wx', mode & 0o7777);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.chmod(temp, mode & 0o7777);
    await validate?.();
    await fs.rename(temp, target);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

interface DiffLine {
  type: ' ' | '+' | '-';
  text: string;
}

function unifiedDiff(before: string, after: string, filePath: string): string {
  const oldLines = diffLines(before);
  const newLines = diffLines(after);
  const operations = lineDiff(oldLines, newLines);
  const changed = operations.flatMap((operation, index) => operation.type === ' ' ? [] : [index]);
  if (changed.length === 0) return `--- a/${filePath}\n+++ b/${filePath}\n(no textual diff)`;

  const ranges: Array<{ start: number; end: number }> = [];
  for (const index of changed) {
    const start = Math.max(0, index - 3);
    const end = Math.min(operations.length, index + 4);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }

  const output = [`--- a/${filePath}`, `+++ b/${filePath}`];
  for (const range of ranges) {
    const rangeOps = operations.slice(range.start, range.end);
    const oldCount = rangeOps.filter((operation) => operation.type !== '+').length;
    const newCount = rangeOps.filter((operation) => operation.type !== '-').length;
    const oldBefore = operations.slice(0, range.start).filter((operation) => operation.type !== '+').length;
    const newBefore = operations.slice(0, range.start).filter((operation) => operation.type !== '-').length;
    const oldStart = oldBefore + (oldCount === 0 ? 0 : 1);
    const newStart = newBefore + (newCount === 0 ? 0 : 1);
    output.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const operation of rangeOps) output.push(`${operation.type}${operation.text}`);
  }

  const maxLines = 100;
  if (output.length > maxLines) return [...output.slice(0, maxLines), '... diff truncated ...'].join('\n');
  const rendered = output.join('\n');
  const maxCharacters = 12_000;
  return rendered.length > maxCharacters
    ? `${rendered.slice(0, maxCharacters)}\n... diff truncated ...`
    : rendered;
}

function diffLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.replace(/\r\n|\r/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function lineDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  const oldLength = oldLines.length;
  const newLength = newLines.length;
  const width = newLength + 1;
  if ((oldLength + 1) * width > 1_000_000) return coarseLineDiff(oldLines, newLines);
  const table = new Uint32Array((oldLength + 1) * width);
  for (let oldIndex = oldLength - 1; oldIndex >= 0; oldIndex--) {
    for (let newIndex = newLength - 1; newIndex >= 0; newIndex--) {
      const cell = oldIndex * width + newIndex;
      table[cell] = oldLines[oldIndex] === newLines[newIndex]
        ? table[(oldIndex + 1) * width + newIndex + 1] + 1
        : Math.max(table[(oldIndex + 1) * width + newIndex], table[oldIndex * width + newIndex + 1]);
    }
  }

  const operations: DiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLength && newIndex < newLength) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      operations.push({ type: ' ', text: oldLines[oldIndex++] });
      newIndex++;
    } else if (table[(oldIndex + 1) * width + newIndex] >= table[oldIndex * width + newIndex + 1]) {
      operations.push({ type: '-', text: oldLines[oldIndex++] });
    } else {
      operations.push({ type: '+', text: newLines[newIndex++] });
    }
  }
  while (oldIndex < oldLength) operations.push({ type: '-', text: oldLines[oldIndex++] });
  while (newIndex < newLength) operations.push({ type: '+', text: newLines[newIndex++] });
  return operations;
}

function coarseLineDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix &&
    oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]) suffix++;
  return [
    ...oldLines.slice(0, prefix).map((text): DiffLine => ({ type: ' ', text })),
    ...oldLines.slice(prefix, oldLines.length - suffix).map((text): DiffLine => ({ type: '-', text })),
    ...newLines.slice(prefix, newLines.length - suffix).map((text): DiffLine => ({ type: '+', text })),
    ...oldLines.slice(oldLines.length - suffix).map((text): DiffLine => ({ type: ' ', text })),
  ];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function snapshotsForSession(
  snapshots: Map<string, Map<string, FileSnapshot>>,
  context: ToolContext,
): Map<string, FileSnapshot> {
  if (typeof context.sessionId !== 'string' || !context.sessionId) {
    throw new Error('File tracking unavailable: Pi session ID is missing; refusing to use a tool-call ID');
  }
  let sessionSnapshots = snapshots.get(context.sessionId);
  if (!sessionSnapshots) {
    sessionSnapshots = new Map();
    snapshots.set(context.sessionId, sessionSnapshots);
  }
  return sessionSnapshots;
}

function snapshot(stat: { size: number; mtimeMs: number }, bytes: Buffer): FileSnapshot {
  return { size: stat.size, mtimeMs: stat.mtimeMs, sha256: sha256(bytes) };
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function splitReadLines(text: string): Array<{ text: string; ending: string }> {
  const lines: Array<{ text: string; ending: string }> = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '\r' && text[index] !== '\n') continue;
    const ending = text[index] === '\r' && text[index + 1] === '\n' ? '\r\n' : text[index];
    lines.push({ text: text.slice(start, index), ending });
    if (ending.length === 2) index++;
    start = index + 1;
  }
  if (start < text.length) lines.push({ text: text.slice(start), ending: '' });
  return lines;
}

function truncateReadLine(line: string, maxLineLength: number): string {
  let index = 0;
  let characters = 0;
  while (index < line.length && characters <= maxLineLength) {
    const codePoint = line.codePointAt(index)!;
    index += codePoint > 0xffff ? 2 : 1;
    characters++;
  }
  if (characters <= maxLineLength) return line;

  const markerLength = [...READ_LINE_TRUNCATION_MARKER].length;
  const maxContentLength = maxLineLength - markerLength;
  index = 0;
  characters = 0;
  while (index < line.length && characters < maxContentLength) {
    const codePoint = line.codePointAt(index)!;
    index += codePoint > 0xffff ? 2 : 1;
    characters++;
  }
  return `${line.slice(0, index)}${READ_LINE_TRUNCATION_MARKER}`;
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
    let ancestor = path.dirname(candidate);
    const suffix = [path.basename(candidate)];
    while (true) {
      try {
        const realAncestor = await fs.realpath(ancestor);
        if (!inside(root, realAncestor)) throw new Error('Path is outside the working directory');
        resolved = path.join(realAncestor, ...suffix.reverse());
        break;
      } catch (ancestorError) {
        if ((ancestorError as NodeJS.ErrnoException).code !== 'ENOENT') throw ancestorError;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw new Error('No existing parent directory found');
        suffix.push(path.basename(ancestor));
        ancestor = parent;
      }
    }
  }
  if (!inside(root, resolved)) throw new Error('Path is outside the working directory');
  return resolved;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
