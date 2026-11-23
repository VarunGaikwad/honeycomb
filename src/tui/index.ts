import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { basename } from 'node:path';
import { readGitStatus } from '../tools/git.ts';
import type { PermissionController, PermissionMode } from '../extension/permission-modes/index.ts';
import { installPromptEditor } from './editor.ts';
import { displayModel, renderHeader } from './header.ts';
import { ASCII, fit, glyphs, literal } from './text.ts';

const badges = {
  default: ['manual mode on', 'muted', '⏸'],
  acceptEdits: ['accept edits on', 'success', '⏵⏵'],
  plan: ['plan mode on', 'accent', '⏸'],
  auto: ['auto mode on', 'warning', '⏵⏵'],
  dontAsk: ['no prompts', 'warning', '⏵⏵'],
  bypassPermissions: ['bypass permissions on', 'error', '⏵⏵'],
} as const satisfies Record<PermissionMode, readonly [string, string, string]>;

type ModeSource = Pick<PermissionController, 'mode' | 'label' | 'cycle' | 'subscribe'>;

export function installTui(ctx: ExtensionContext, permissions?: ModeSource): void {
  const cycleKey = installPromptEditor(ctx, permissions?.cycle);
  ctx.ui.setHeader((_tui, theme) => ({
    render: width => renderHeader(width, theme, ctx.cwd, ctx.model, cycleKey),
    invalidate() {},
  }));
  ctx.ui.setWorkingIndicator?.({
    frames: (ASCII ? ['*', '+', '.'] : ['✳', '✶', '✻', '✽']).map(frame => ctx.ui.theme.fg('accent', frame)),
    intervalMs: 120,
  });

  ctx.ui.setFooter((tui, theme, footerData) => {
    const unsubscribeMode = permissions?.subscribe(() => tui.requestRender());
    const abort = new AbortController();
    let dirty = false;
    let polling = false;
    const pollGit = async () => {
      if (polling || abort.signal.aborted || !footerData.getGitBranch()) return;
      polling = true;
      try {
        const result = await readGitStatus({ workingDirectory: ctx.cwd, sessionId: 'footer', signal: abort.signal }, ['--porcelain'], 1500);
        const next = !!result.success && !!result.output?.trim();
        if (!abort.signal.aborted && next !== dirty) {
          dirty = next;
          tui.requestRender();
        }
      } catch { /* A status check must not interrupt the editor. */ }
      finally { polling = false; }
    };
    void pollGit();
    const tick = setInterval(() => void pollGit(), 5000);
    tick.unref?.();
    const unsubscribe = footerData.onBranchChange(() => {
      dirty = false;
      void pollGit();
      tui.requestRender();
    });

    return {
      dispose() {
        abort.abort();
        clearInterval(tick);
        unsubscribe();
        unsubscribeMode?.();
      },
      invalidate() {},
      render(width: number): string[] {
        if (width <= 0) return [];
        const mode = permissions?.mode ?? 'default';
        const [label, color, symbol] = badges[mode];
        const marker = `${ASCII ? (symbol === '⏸' ? '||' : '>>') : symbol} `;
        const full = theme.fg(color, marker + label);
        const hint = theme.fg('dim', ` (${cycleKey} to cycle)`);
        const badge = permissions ? (visibleWidth(full) <= width ? full : theme.fg(color, permissions.label)) : '';
        const left = badge + (permissions && visibleWidth(badge + hint) <= width ? hint : '');
        const branch = footerData.getGitBranch();
        const context = ctx.getContextUsage?.();
        const cwd = literal(basename(ctx.cwd) || ctx.cwd);
        const parts = [displayModel(ctx.model), cwd + (branch ? ` (${literal(branch)}${dirty ? '*' : ''})` : ''),
          ...(context?.percent != null ? [`${Math.round(context.percent)}% context`] : [])];
        const getStatus = () => parts.join(` ${glyphs.sep} `);
        while (parts.length && visibleWidth(getStatus()) + visibleWidth(left) + (left ? 3 : 0) > width) parts.pop();
        const status = getStatus();
        return [status ? left + ' '.repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(status))) + theme.fg('dim', status) : fit(left, width)];
      },
    };
  });
}
