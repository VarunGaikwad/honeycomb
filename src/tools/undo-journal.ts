import type { ToolContext, UndoEntry } from '../types/index.ts';
import { isProtectedWrite } from '../extension/permission-modes/paths.ts';

export const MAX_UNDO_FILE_BYTES = 1024 * 1024;
const MAX_UNDO_BYTES = 8 * MAX_UNDO_FILE_BYTES;

export function createUndoJournal() {
  const entries: UndoEntry[] = [];
  let scope = '';
  const select = (ctx: ToolContext) => {
    const key = JSON.stringify([ctx.sessionId, ctx.workingDirectory, ctx.undoEpoch]);
    if (key !== scope) { entries.length = 0; scope = key; }
    return key;
  };
  const size = (items: UndoEntry[]) => items.reduce((sum, item) => sum + (item.before?.length ?? 0), 0);
  return {
    entries,
    invalidateSnapshots: undefined as ((ctx: ToolContext, files: string[]) => void) | undefined,
    select,
    current: (key: string) => scope === key,
    record(ctx: ToolContext, items: UndoEntry[]) {
      select(ctx);
      if (!items.length || size(items) > MAX_UNDO_BYTES || items.some(item => isProtectedWrite(item.file) || (item.before?.length ?? 0) > MAX_UNDO_FILE_BYTES)) {
        entries.length = 0;
        return;
      }
      entries.push(...items);
      while (size(entries) > MAX_UNDO_BYTES || new Set(entries.map(item => item.id)).size > 20) {
        const oldest = entries[0]?.id;
        while (entries.length && entries[0]?.id === oldest) entries.shift();
      }
    },
  };
}
export type UndoJournal = ReturnType<typeof createUndoJournal>;
