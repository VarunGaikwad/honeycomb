import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { basename } from 'node:path';
import { readGitStatus } from '../tools/git.ts';
import type { PermissionController, PermissionMode } from '../extension/permission-modes/index.ts';
import { installPromptEditor } from './editor.ts';
import { displayModel, renderHeader } from './header.ts';
import { compactNumber, durationText, footerStats } from './footer-stats.ts';
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

export function installTui(ctx: ExtensionContext, permissions?: ModeSource, footerStyle: 'compact' | 'detailed' = 'detailed'): void {
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
    let cachedStats: ReturnType<typeof footerStats> | undefined;
    let cacheKey = '';
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
    const tick = setInterval(() => { void pollGit(); tui.requestRender(); }, 5000);
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
        if (footerStyle === 'compact') {
          const parts = [displayModel(ctx.model), cwd + (branch ? ` (${literal(branch)}${dirty ? '*' : ''})` : ''),
            ...(context?.percent != null ? [`${Math.round(context.percent)}% context`] : [])];
          const status = () => parts.join(` ${glyphs.sep} `);
          while (parts.length && visibleWidth(status()) + visibleWidth(left) + (left ? 3 : 0) > width) parts.pop();
          const text = status();
          return [text ? left + ' '.repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(text))) + theme.fg('dim', text) : fit(left, width)];
        }
        const entries = ctx.sessionManager.getEntries();
        const key = `${ctx.sessionManager.getSessionId()}:${ctx.sessionManager.getLeafId()}:${entries.length}`;
        if (!cachedStats || cacheKey !== key) { cachedStats = footerStats(entries); cacheKey = key; }
        const stats = cachedStats;
        const percent = context?.percent == null ? null : Math.max(0, Math.min(100, Math.floor(context.percent)));
        const bar = percent === null ? '? context' : `${(ASCII ? '#' : '▰').repeat(Math.round(percent / 10))}${(ASCII ? '-' : '▱').repeat(10 - Math.round(percent / 10))} ${percent}%`;
        const model = displayModel(ctx.model) + (ctx.thinkingLevel && ctx.thinkingLevel !== 'off' ? ` · ${literal(ctx.thinkingLevel)}` : '');
        const last = [...ctx.sessionManager.getBranch()].reverse().find(entry => entry.type === 'message' && entry.message.role === 'assistant');
        const lastMessage = last?.type === 'message' && last.message.role === 'assistant' ? last.message : undefined;
        const lastModel = lastMessage && ctx.model && (lastMessage.model !== ctx.model.id || lastMessage.provider !== ctx.model.provider)
          ? ` (last: ${literal(lastMessage.provider)}/${literal(lastMessage.model)})` : '';
        const contextColor = percent === null ? 'dim' : percent >= 80 ? 'error' : percent >= 50 ? 'warning' : 'success';
        const first = [theme.fg('accent', model + lastModel), theme.fg(contextColor, bar + (context?.contextWindow ? ` of ${compactNumber(context.contextWindow)}` : '')), `${ASCII ? 'prompts' : '💬'} ${stats.prompts}`, cwd + (branch ? ` (${literal(branch)}${dirty ? '*' : ''})` : '')];
        const hit = stats.input ? ` (${Math.round(stats.read / stats.input * 100)}% hit)` : '';
        const start = Date.parse(ctx.sessionManager.getHeader()?.timestamp ?? '');
        const second = [`↓ ${compactNumber(stats.input)} in ↑ ${compactNumber(stats.output)} out`, `cache R ${compactNumber(stats.read)} W ${compactNumber(stats.write)}${hit}`,
          ...(stats.timed ? [`${durationText(stats.duration)} API${stats.timed < stats.assistants ? ' partial' : ''}`] : []),
          ...(Number.isFinite(start) ? [`${durationText(Date.now() - start)} elapsed`] : []),
          ...(stats.models.length > 1 ? [stats.models.map(model => literal(model)).join(' + ')] : [])];
        const cost = `est. $${stats.cost.toFixed(3)}`;
        const line = (parts: string[], right?: string) => {
          const shown = [...parts];
          const joined = () => shown.join(` ${glyphs.sep} `);
          if (right && visibleWidth(joined()) + visibleWidth(right) + 3 <= width) {
            return joined() + ' '.repeat(width - visibleWidth(joined()) - visibleWidth(right)) + right;
          }
          if (right) shown.push(right);
          while (shown.length > 1 && visibleWidth(joined()) > width) shown.pop();
          return fit(joined(), width);
        };
        return [line(first.slice(0, -1), first.at(-1)), theme.fg('dim', line(second, cost)), ...(left ? [fit(left, width)] : [])];
      },
    };
  });
}
