import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Todo } from '../types/index.ts';
import { fit, literal } from '../tui/text.ts';
import { readGoalState, goalStatusText } from './goal/state.ts';

export const TODO_ENTRY = 'bi.todos';
export function readTodos(entries: readonly unknown[]): Todo[] {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as { type?: string; customType?: string; data?: unknown } | undefined;
    if (entry?.type !== 'custom' || entry.customType !== TODO_ENTRY) continue;
    const data = entry.data;
    if (Array.isArray(data) && data.length <= 100 && data.every(t => t && typeof t.id === 'string' && t.id.length <= 64 && typeof t.text === 'string' && t.text.length <= 1000 && typeof t.done === 'boolean')) {
      return data.map(({ id, text, done }) => ({ id, text, done }));
    }
  }
  return [];
}

export function registerTasksCommand(pi: ExtensionAPI): void {
  pi.registerCommand('tasks', {
    description: 'Show the current goal and todos without changing them',
    async handler(_args, ctx) {
      if (!ctx.hasUI) return;
      if (!ctx.isIdle() || ctx.hasPendingMessages()) return ctx.ui.notify('Wait for the current run before opening /tasks.', 'warning');
      const branch = ctx.sessionManager.getBranch();
      const goal = readGoalState(branch);
      const todos = readTodos(branch);
      const verification = goal?.verification;
      const evidence = verification && ['passed', 'failed', 'not_run'].includes(verification.status) && typeof verification.summary === 'string'
        ? `${verification.status.replace('_', ' ')} — ${literal(verification.summary.slice(0, 1000))}` : 'not reported';
      const rows = [
        ...(goal ? [literal(goalStatusText(goal), true), `Remaining in current budget: ${Math.max(0, goal.maxIterations - goal.iteration)}`, `Latest verification (agent-reported): ${evidence}`] : ['No saved goal.']),
        '', `Todos: ${todos.filter(todo => todo.done).length}/${todos.length} complete`,
        ...(todos.length ? todos.map(todo => `${todo.done ? '[x]' : '[ ]'} ${literal(todo.text)}`) : ['No todos on this branch.']),
      ].flatMap(row => row.split('\n'));
      if (ctx.mode !== 'tui') return ctx.ui.notify(rows.join('\n').slice(0, 8000), 'info');
      await ctx.ui.custom<void>((tui, theme, keys, done) => {
        let offset = 0, page = 1;
        return {
          render(width) {
            page = Math.max(1, tui.terminal.rows - 5);
            offset = Math.max(0, Math.min(offset, rows.length - page));
            return [theme.fg('accent', 'Session tasks'), ...rows.slice(offset, offset + page), '↑/↓/PgUp/PgDn: scroll · Esc: close'].map(line => fit(line, width));
          },
          handleInput(data) {
            if (keys.matches(data, 'tui.select.cancel')) return done(undefined);
            if (keys.matches(data, 'tui.select.up')) offset--;
            else if (keys.matches(data, 'tui.select.down')) offset++;
            else if (keys.matches(data, 'tui.select.pageUp')) offset -= page;
            else if (keys.matches(data, 'tui.select.pageDown')) offset += page;
            else return;
            tui.requestRender();
          },
          invalidate() {},
        };
      });
    },
  });
}
