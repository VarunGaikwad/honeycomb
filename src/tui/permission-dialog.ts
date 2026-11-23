import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { matchesKey, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { fit, glyphs as g, literal } from './text.ts';

export type PreviewLine = { text: string; color?: 'dim' | 'warning' | 'toolDiffAdded' | 'toolDiffRemoved' };
const numberKeys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

type Choice<T extends string> = { value: T; label?: string };
type Dialog<T extends string> = {
  title: string;
  preview: readonly PreviewLine[];
  options: readonly Choice<T>[];
  initial: T;
};

async function show<T extends string>(ctx: ExtensionContext, dialog: Dialog<T>, signal: AbortSignal | undefined,
  fallback: () => Promise<T | undefined>): Promise<T | undefined> {
  if (!ctx.hasUI || signal?.aborted) return;
  let result: T | undefined;
  try {
    result = ctx.mode === 'tui' ? await ctx.ui.custom<T | undefined>((tui, theme, keys, done) => {
      let selected = Math.max(0, dialog.options.findIndex(o => o.value === dialog.initial));
      let first = 0;
      let viewport = 1;
      let lines: string[] = [];
      let cachedWidth: number | undefined;
      const cancel = () => done(undefined);
      signal?.addEventListener('abort', cancel, { once: true });
      return {
        render(width) {
          if (width <= 0) return [];
          if (cachedWidth !== width) {
            cachedWidth = width;
            lines = dialog.preview.flatMap(({ text, color }) => wrapTextWithAnsi(literal(text, true), Math.max(1, width - 2))
              .map(line => color ? theme.fg(color, line) : line));
          }
          viewport = Math.max(1, Math.min(12, tui.terminal.rows - dialog.options.length - 6, Math.floor(tui.terminal.rows / 2)));
          first = Math.max(0, Math.min(first, lines.length - viewport));
          const preview = lines.slice(first, first + viewport).map(line => '  ' + line);
          if (lines.length > viewport) {
            preview.push(theme.fg('dim', `  ${first + 1}-${Math.min(first + viewport, lines.length)}/${lines.length}  PageUp/PageDown`));
          }
          return [theme.fg('warning', g.rule.repeat(width)), theme.fg('warning', dialog.title), ...preview, '',
            ...dialog.options.map(({ value, label }, i) => {
              const text = `${i === selected ? g.pointer : ' '} ${i + 1}. ${label ?? value}`;
              return i === selected ? theme.fg('accent', text) : text;
            }), theme.fg('dim', 'Enter to select · Esc to cancel')].map(line => fit(line, width));
        },
        handleInput(data) {
          if (signal?.aborted || keys.matches(data, 'tui.select.cancel')) return cancel();
          const number = numberKeys.findIndex(key => matchesKey(data, key));
          if (number >= 0 && dialog.options[number]) return done(dialog.options[number]!.value);
          if (keys.matches(data, 'tui.select.confirm')) return done(dialog.options[selected]?.value);
          if (keys.matches(data, 'tui.select.up')) selected = (selected + dialog.options.length - 1) % dialog.options.length;
          else if (keys.matches(data, 'tui.select.down')) selected = (selected + 1) % dialog.options.length;
          else if (keys.matches(data, 'tui.select.pageUp')) first -= viewport;
          else if (keys.matches(data, 'tui.select.pageDown')) first += viewport;
          else return;
          tui.requestRender();
        },
        invalidate() { cachedWidth = undefined; },
        dispose() { signal?.removeEventListener('abort', cancel); },
      };
    }, { blocked: { kind: 'permission', message: dialog.title } }) : await fallback();
  } catch { /* Dismissal, a failed UI, or an unsupported client never grants permission. */ }
  return !signal?.aborted && dialog.options.some(option => option.value === result) ? result : undefined;
}

/** Tool batches can execute in parallel. Do not stack two approval prompts over one editor. */
export function createPermissionPrompter() {
  let queue = Promise.resolve();
  function enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = queue.then(run);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }
  return {
    choose<T extends string>(ctx: ExtensionContext, dialog: Dialog<T>): Promise<T | undefined> {
      const signal = ctx.signal;
      return enqueue(() => show(ctx, dialog, signal, async () => {
        const details = dialog.preview.map(({ text }) => literal(text, true)).join('\n');
        const choice = await ctx.ui.select(details ? `${dialog.title}\n${details}` : dialog.title, dialog.options.map(o => o.value), { signal });
        return dialog.options.find(o => o.value === choice)?.value;
      }));
    },
    async confirm(ctx: ExtensionContext, title: string, message: string, signal = ctx.signal): Promise<boolean> {
      const dialog: Dialog<'Yes' | 'No'> = { title, preview: [{ text: message }], options: [{ value: 'Yes' }, { value: 'No' }], initial: 'No' };
      const result = await enqueue(() => show(ctx, dialog, signal, async () => await ctx.ui.confirm(title, literal(message, true), { signal }) ? 'Yes' : 'No'));
      return result === 'Yes';
    },
  };
}

export type PermissionPrompter = ReturnType<typeof createPermissionPrompter>;
