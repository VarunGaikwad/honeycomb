import { CustomEditor, type ExtensionContext, type KeybindingsManager } from '@earendil-works/pi-coding-agent';
import { matchesKey, type EditorTheme, type TUI } from '@earendil-works/pi-tui';
import { ASCII, glyphs } from './text.ts';

const biEditors = new WeakSet<object>();
export function hasBiPromptEditor(ctx: ExtensionContext): boolean {
  const factory = ctx.ui.getEditorComponent?.();
  return !!factory && biEditors.has(factory);
}

export class BiPromptEditor extends CustomEditor {
  constructor(tui: TUI, theme: EditorTheme, private readonly keys: KeybindingsManager, private readonly cycle: () => void, private readonly accent: (text: string) => string) {
    super(tui, theme, keys, { paddingX: 1 });
  }

  override setPaddingX(padding: number): void {
    // Reserve a column inside Pi's own layout so cursor/mouse coordinates agree.
    super.setPaddingX(Math.max(1, padding));
  }

  override handleInput(data: string): void {
    if (matchesKey(data, 'shift+tab') && !this.isShowingAutocomplete()) {
      this.cycle();
      return;
    }
    // Keep thinking accessible without rewriting the user's Pi keybindings.
    if (matchesKey(data, 'alt+t') && this.keys.getKeys('app.thinking.cycle').includes('shift+tab')) {
      const changeThinking = this.actionHandlers.get('app.thinking.cycle');
      if (changeThinking) {
        if (!this.onExtensionShortcut?.(data)) changeThinking();
        return;
      }
    }
    super.handleInput(data);
  }

  override render(width: number): string[] {
    const lines = [...super.render(width)];
    if (width >= 3 && lines[1]?.startsWith(' ')) lines[1] = this.accent(glyphs.pointer) + lines[1].slice(1);
    return lines;
  }

  protected override renderTopBorder(width: number, hidden: number): string {
    return ASCII && !hidden ? this.borderColor('-'.repeat(width)) : super.renderTopBorder(width, hidden);
  }

  protected override renderBottomBorder(width: number, hidden: number): string {
    return ASCII && !hidden ? this.borderColor('-'.repeat(width)) : super.renderBottomBorder(width, hidden);
  }
}

/** Don't displace another extension's editor. The registered Alt+M shortcut remains available. */
export function installPromptEditor(ctx: ExtensionContext, cycle?: () => void): 'shift+tab' | 'alt+m' {
  if (!cycle || !ctx.ui.setEditorComponent || ctx.ui.getEditorComponent?.()) return 'alt+m';
  const factory: Parameters<typeof ctx.ui.setEditorComponent>[0] = (tui, theme, keys) => new BiPromptEditor(tui, theme, keys, cycle, text => ctx.ui.theme.fg('accent', text));
  biEditors.add(factory);
  ctx.ui.setEditorComponent(factory);
  return 'shift+tab';
}
