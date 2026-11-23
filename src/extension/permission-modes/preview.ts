import type { PreviewLine } from '../../tui/permission-dialog.ts';
import { literal } from '../../tui/text.ts';

const MAX_FILE_PREVIEW = 12_000;
const actions = new Map([
  ['read', 'Read file?'], ['edit', 'Edit file?'], ['write', 'Write file?'], ['apply_patch', 'Apply patch?'],
  ['delete', 'Delete path?'], ['copy', 'Copy path?'], ['move', 'Move path?'], ['mkdir', 'Create directory?'],
]);

function previewText(value: string, color?: PreviewLine['color'], prefix = ''): PreviewLine {
  const clipped = value.length > MAX_FILE_PREVIEW;
  const text = value.slice(0, MAX_FILE_PREVIEW).split('\n').map(line => prefix + line).join('\n');
  return { text: clipped ? `${text}\n[preview truncated]` : text, color };
}

export function previewToolCall(toolName: string, input: Record<string, unknown>): { title: string; preview: PreviewLine[] } {
  if (['bash', 'background', 'terminal'].includes(toolName)) {
    if (typeof input.command === 'string') return {
      title: toolName === 'background' ? 'Start a background command?' : 'Run shell command?',
      preview: [{ text: input.command }],
    };
    if (toolName === 'terminal' && typeof input.input === 'string') return {
      title: 'Send input to terminal?',
      preview: [{ text: `Process: ${literal(String(input.processId))}`, color: 'dim' }, { text: input.input }],
    };
  }
  const title = actions.get(toolName) ?? `Allow ${literal(toolName)}?`;
  const preview: PreviewLine[] = [];
  for (const [key, name] of [['path', 'Path'], ['source', 'From'], ['destination', 'To']] as const) {
    const value = input[key];
    if (typeof value === 'string') preview.push({ text: `${name}: ${literal(value)}` });
  }
  if (toolName === 'write' && typeof input.content === 'string') preview.push(previewText(input.content, 'toolDiffAdded', '+ '));
  if (toolName === 'apply_patch' || toolName === 'edit') {
    const edits = Array.isArray(input.edits) ? input.edits : [input];
    for (const edit of edits.slice(0, 10)) {
      if (!edit || typeof edit !== 'object') continue;
      if (typeof edit.path === 'string' && edit !== input) preview.push({ text: `Path: ${literal(edit.path)}` });
      const before = edit.old_str ?? edit.oldText, after = edit.new_str ?? edit.newText;
      if (edit.replace_all === true || input.replace_all === true) preview.push({ text: 'Replace all matches', color: 'warning' });
      if (typeof before === 'string') preview.push(previewText(before, 'toolDiffRemoved', '- '));
      if (typeof after === 'string') preview.push(previewText(after, 'toolDiffAdded', '+ '));
    }
    if (edits.length > 10) preview.push({ text: `[${edits.length - 10} additional edits not shown]`, color: 'warning' });
  }
  if (!preview.length) preview.push(previewText(JSON.stringify(input, null, 2)));
  return { title, preview };
}
