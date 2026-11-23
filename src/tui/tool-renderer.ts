import type { ToolRenderers } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { ASCII, literal } from './text.ts';

const labels = new Map([
  ['read', 'Read'], ['write', 'Write'], ['edit', 'Edit'], ['bash', 'Bash'],
  ['grep', 'Search'], ['find', 'Find'], ['ls', 'List'], ['apply_patch', 'Patch'],
]);

export function toolPresentation(name: string): ToolRenderers {
  const label = labels.get(name);
  if (!label) return {};
  const marker = ASCII ? '*' : '●';
  const resultMarker = ASCII ? '  -> ' : '  ⎿  ';
  return {
    renderShell: 'self',
    renderCall(args, theme, ctx) {
      const { command, path, query, name } = (args ?? {}) as Record<string, unknown>;
      const operand = command ?? path ?? query ?? name;
      const location = typeof operand === 'string' && operand ? `(${literal(operand.slice(0, 150))}${operand.length > 150 ? '...' : ''})` : '';
      return new Text(theme.fg(ctx.isError ? 'error' : 'accent', marker) + ' ' + theme.bold(label) + theme.fg('muted', location), 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, ctx) {
      if (isPartial) return new Text(theme.fg('dim', `${resultMarker}Running...`), 0, 0);
      const output = result.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n').trimEnd();
      const lines = output ? output.split(/\r\n|\n|\r/) : [];
      const hideRead = name === 'read' && !ctx.isError && !expanded;
      const limit = expanded ? lines.length : name === 'edit' || name === 'apply_patch' ? 7 : 3;
      const first = output ? [] : [ctx.isError ? 'Failed' : 'Done'];
      const shown = hideRead ? [`Read ${lines.length} line${lines.length === 1 ? '' : 's'} of output`] : [...first, ...lines.slice(0, limit)];
      const remaining = hideRead ? lines.length : Math.max(0, lines.length - limit);
      const hint = !expanded && remaining ? ctx.keyHint?.('app.tools.expand', 'to expand') : undefined;
      if (remaining) shown.push(hideRead ? (hint ?? 'Output collapsed') : `${remaining} more lines${hint ? ` (${hint})` : ''}`);
      const text = shown.map((line, i) => {
        const diff = name === 'edit' || name === 'apply_patch';
        const color = ctx.isError ? 'error' : diff && line.startsWith('+') ? 'toolDiffAdded' : diff && line.startsWith('-') ? 'toolDiffRemoved' : 'muted';
        return theme.fg(color, (i === 0 ? resultMarker : '     ') + literal(line));
      }).join('\n');
      return new Text(text, 0, 0);
    },
  };
}
