import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  AgentToolDefinition,
  AskQuestion,
  AskUserFn,
  Args,
  Todo,
  Tool,
  ToolContext,
  ToolResult,
  UndoEntry,
} from '../types/index.ts';

/** In-memory agent helpers; undo only restores files unchanged since its own edit. */
export function createAgentTools(options: { askUser?: AskUserFn } = {}): Tool<Args>[] {
  const todos: Todo[] = [];
  const undoStack: UndoEntry[] = [];
  const definitions: AgentToolDefinition[] = [
    {
      name: 'todo',
      description:
        'Track progress on multi-step tasks (3+ steps). action: "list" | "add" (requires text) | "complete" | "remove" (both require id from add/list). In-memory, current session only.',
      promptGuideline:
        'Use todo for tasks with several distinct steps; skip it for single quick edits. Mark items complete as soon as they are done.',
      shape: { action: 'string', text: 'string?', id: 'string?' },
      execute: async (a: Args) => {
        const action = a.action as string;
        if (!['list', 'add', 'complete', 'remove'].includes(action))
          return { success: false, error: 'action must be list, add, complete, or remove' };
        if (action === 'list')
          return {
            success: true,
            output: todos.length
              ? todos.map((t) => `${t.done ? '[x]' : '[ ]'} ${t.id} ${t.text}`).join('\n')
              : 'No todos',
          };
        if (action === 'add') {
          if (typeof a.text !== 'string' || !a.text.trim())
            return { success: false, error: 'text is required to add a todo' };
          const item = { id: randomUUID(), text: a.text, done: false };
          todos.push(item);
          return { success: true, output: item.id };
        }
        if (typeof a.id !== 'string' || !a.id)
          return { success: false, error: 'id is required for complete and remove' };
        const index = todos.findIndex((t) => t.id === a.id);
        if (index < 0) return { success: false, error: 'Todo not found' };
        if (action === 'complete') todos[index].done = true;
        else if (action === 'remove') todos.splice(index, 1);
        return { success: true, output: 'Todo updated' };
      },
    },
    ...(options.askUser ? [{
      name: 'ask_user',
      description:
        'Ask 1–4 structured questions when a decision materially changes the outcome and cannot be discovered from the repository. Not for permission, progress, or whether to proceed.',
      promptGuideline:
        'Do not ask for things you can discover by reading files or running commands, and do not ask for permission to proceed with what was already requested.',
      shape: {},
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            minItems: 1,
            maxItems: 4,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                header: { type: 'string' },
                question: { type: 'string' },
                multiSelect: { type: 'boolean' },
                options: {
                  type: 'array',
                  minItems: 2,
                  maxItems: 4,
                  items: {
                    type: 'object',
                    properties: {
                      label: { type: 'string' },
                      description: { type: 'string' },
                      recommended: { type: 'boolean' },
                    },
                    required: ['label', 'description'],
                    additionalProperties: false,
                  },
                },
              },
              required: ['id', 'header', 'question', 'multiSelect', 'options'],
              additionalProperties: false,
            },
          },
        },
        required: ['questions'],
        additionalProperties: false,
      },
      execute: async (a: Args) => {
        const questions = a.questions;
        if (
          !Array.isArray(questions) ||
          questions.length < 1 ||
          questions.length > 4 ||
          questions.some((q) => !isAskQuestion(q))
        ) {
          return { success: false, error: 'questions must contain 1–4 valid structured questions' };
        }
        return {
          success: true,
          output: JSON.stringify(await options.askUser!(questions as AskQuestion[])),
        };
      },
    }] : []),
    {
      name: 'plan',
      description:
        'Format an ordered implementation plan before a large multi-file change. Returns numbered text only; does not store or track anything — use todo for tracking.',
      promptGuideline:
        'Use only before changes spanning several files; skip it for small or single-file edits.',
      shape: { steps: 'array' },
      execute: async (a) => ({
        success: true,
        output: (a.steps as string[]).map((step, i) => `${i + 1}. ${step}`).join('\n'),
      }),
    },
    {
      name: 'apply_patch',
      description:
        'Replace exact text in existing files. Each edit: path, oldText (must match exactly once, whitespace included), newText. Max one edit per file per call — for multiple changes in one file, use a larger oldText or separate calls. All-or-nothing: if any edit fails, none are applied. Cannot create files. Not a unified diff.',
      promptGuideline:
        'Prefer apply_patch over edit/write for changes to existing files so they can be undone. Include enough surrounding context in oldText to make it unique.',
      shape: { edits: 'array' },
      arrayItems: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the working directory' },
          oldText: {
            type: 'string',
            description: 'Exact existing text to replace; must match exactly once',
          },
          newText: { type: 'string', description: 'Replacement text' },
        },
        required: ['path', 'oldText', 'newText'],
        additionalProperties: false,
      },
      execute: async (a, c) => {
        const edits = a.edits as Array<Record<string, unknown>>;
        if (edits.length === 0) return { success: false, error: 'At least one edit is required' };

        // Phase 1: validate + resolve sab kuch, disk pe kuch likhne se pehle
        const resolved: Array<{ path: string; file: string; oldText: string; newText: string }> =
          [];
        const seen = new Map<string, string>(); // fileKey -> pehla path jo is file ko point karta hai
        try {
          for (const edit of edits) {
            if (
              typeof edit.path !== 'string' ||
              typeof edit.oldText !== 'string' ||
              typeof edit.newText !== 'string'
            )
              throw new Error('Each edit requires path, oldText, and newText strings');
            if (!edit.oldText) throw new Error(`oldText must not be empty (${edit.path})`);
            const file = await safeFile(c, edit.path);
            const st = await fs.stat(file, { bigint: true });
            if (!st.isFile()) throw new Error(`Not a regular file: ${edit.path}`);
            // ino 0 kuch filesystems pe aata hai (unreliable) → tab real path fallback
            const key = st.ino !== 0n ? `${st.dev}:${st.ino}` : file;
            const prev = seen.get(key);
            if (prev !== undefined)
              throw new Error(
                `"${prev}" and "${edit.path}" refer to the same file; only one edit per file is allowed per apply_patch call`,
              );
            seen.set(key, edit.path);
            resolved.push({ path: edit.path, file, oldText: edit.oldText, newText: edit.newText });
          }
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : 'Patch failed' };
        }

        // Phase 2: write karo + undo ke liye record rakho
        const pending: UndoEntry[] = [];
        const operationId = randomUUID();
        try {
          for (const edit of resolved) {
            const original = await fs.readFile(edit.file);
            const text = original.toString('utf8');
            if (!Buffer.from(text, 'utf8').equals(original))
              throw new Error(`${edit.path} is not valid UTF-8; apply_patch cannot edit it safely`);
            const at = text.indexOf(edit.oldText);
            if (at < 0) throw new Error(`Match not found in ${edit.path}`);
            if (text.indexOf(edit.oldText, at + 1) >= 0)
              throw new Error(`Match is not unique in ${edit.path}`);
            const updated = text.slice(0, at) + edit.newText + text.slice(at + edit.oldText.length);
            await fs.writeFile(edit.file, updated, 'utf8');
            pending.push({
              id: operationId,
              file: edit.file,
              before: original,
              afterHash: hash(Buffer.from(updated)),
            });
          }
        } catch (error) {
          // Is call ke completed edits restore karo, sirf agar content abhi bhi hamara hai
          for (const entry of pending.reverse()) {
            try {
              if (hash(await fs.readFile(entry.file)) === entry.afterHash) {
                if (entry.before) await fs.writeFile(entry.file, entry.before);
                else await fs.rm(entry.file);
              }
            } catch {
              // rollback best-effort hai; ek file fail ho toh baaki continue
            }
          }
          return { success: false, error: error instanceof Error ? error.message : 'Patch failed' };
        }
        undoStack.push(...pending);
        return {
          success: true,
          output: `Applied ${pending.length} edit(s)`,
          metadata: { operationIds: [operationId] },
        };
      },
    },
    {
      name: 'undo',
      description:
        'Revert the most recent apply_patch operation (all files in it). Each call reverts one operation; call again to go further back. Refuses if any affected file changed since that patch.',
      promptGuideline:
        'Use when the user asks to revert, or when your own last patch was wrong. If undo refuses, fix forward with apply_patch instead. Cannot undo edits from edit, write, or shell commands.',
      shape: {},
      execute: async () => {
        if (!undoStack.length)
          return { success: false, error: 'No agent edits are available to undo' };
        const lastId = undoStack[undoStack.length - 1].id;
        const entries = undoStack.filter((entry) => entry.id === lastId);
        for (const entry of entries) {
          let current: Buffer;
          try {
            current = await fs.readFile(entry.file);
          } catch {
            return { success: false, error: `Cannot undo: ${entry.file} is missing` };
          }
          if (hash(current) !== entry.afterHash)
            return {
              success: false,
              error: `Cannot undo: ${entry.file} changed since the agent edit`,
            };
        }
        while (undoStack.length && undoStack[undoStack.length - 1].id === lastId) undoStack.pop();
        for (const entry of [...entries].reverse()) {
          if (entry.before) await fs.writeFile(entry.file, entry.before);
          else await fs.rm(entry.file);
        }
        return { success: true, output: `Undid ${entries.length} edit(s)` };
      },
    },
  ];
  return definitions.map(({ name, description, promptGuideline, shape, execute, arrayItems, parameters }) =>
    tool(name, description, shape, execute, promptGuideline, arrayItems, parameters),
  );
}

function tool(
  name: string,
  description: string,
  shape: Record<string, string>,
  execute: (args: Args, context: ToolContext) => Promise<ToolResult>,
  promptGuideline?: string,
  arrayItems?: Record<string, unknown>,
  parameters?: Record<string, unknown>,
): Tool<Args> {
  return {
    name,
    description,
    ...(promptGuideline ? { promptSnippet: description, promptGuidelines: [promptGuideline] } : {}),
    parameters: parameters ?? {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(shape).map(([k, type]) => [
          k,
          type === 'array'
            ? { type: 'array', items: arrayItems ?? { type: 'string' } }
            : { type: type.replace('?', '') },
        ]),
      ),
      required: Object.entries(shape)
        .filter(([, type]) => !type.endsWith('?'))
        .map(([k]) => k),
      additionalProperties: false,
    },
    validate: (value): value is Args => parameters
      ? value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
      : validateArgs(value, shape, arrayItems),
    execute,
  };
}

function isAskQuestion(value: unknown): value is AskQuestion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const q = value as Record<string, unknown>;
  return typeof q.id === 'string' && typeof q.header === 'string' && typeof q.question === 'string' &&
    typeof q.multiSelect === 'boolean' && Array.isArray(q.options) && q.options.length >= 2 && q.options.length <= 4 &&
    q.options.every((option) => {
      if (!option || typeof option !== 'object' || Array.isArray(option)) return false;
      const o = option as Record<string, unknown>;
      return typeof o.label === 'string' && typeof o.description === 'string' &&
        (o.recommended === undefined || typeof o.recommended === 'boolean');
    });
}

function validateArgs(
  value: unknown,
  shape: Record<string, string>,
  arrayItems?: Record<string, unknown>,
): value is Args {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const args = value as Args;
  return Object.entries(shape).every(([key, type]) => {
    const item = args[key];
    if (type.endsWith('?') && item === undefined) return true;
    if (type !== 'array') return typeof item === type.replace('?', '');
    if (!Array.isArray(item)) return false;
    if (!arrayItems) return item.every((entry) => typeof entry === 'string');
    const properties = arrayItems.properties as Record<string, { type?: string }>;
    return item.every(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        !Array.isArray(entry) &&
        Object.entries(properties).every(
          ([key, schema]) => typeof (entry as Args)[key] === schema.type,
        ),
    );
  });
}

async function safeFile(context: ToolContext, input: string): Promise<string> {
  const root = await fs.realpath(context.workingDirectory);
  const target = path.resolve(root, input);
  const rel = path.relative(root, target);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
    throw new Error('Path is outside the working directory');
  let real: string;
  try {
    real = await fs.realpath(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(`File not found: ${input}`);
    throw error;
  }
  const realRel = path.relative(root, real);
  if (realRel === '..' || realRel.startsWith(`..${path.sep}`) || path.isAbsolute(realRel))
    throw new Error('Path is outside the working directory');
  return real;
}

function hash(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
