import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { matchesKey } from '@earendil-works/pi-tui';
import { loadPermissionRules } from '../extension/permission-modes/rules.ts';
import { fit, glyphs, literal } from './text.ts';

export type PermissionActivity = { tool: string; reason: string };

/** Read-only so a cloned project cannot acquire new tool permissions through the viewer. */
export function registerPermissionRules(pi: ExtensionAPI, snapshot: () => { mode: string; approvals: number; denials: readonly PermissionActivity[] }): void {
  pi.registerCommand?.('permissions', {
    description: 'Inspect effective permission rules and recent denials',
    async handler(_args, ctx) {
      if (!ctx.hasUI) return;
      if (!ctx.isIdle()) { ctx.ui.notify('Wait for the current run before viewing permissions.', 'warning'); return; }
      const issues: string[] = [];
      const { groups, invalid } = loadPermissionRules(ctx.cwd, message => issues.push(message));
      const { mode, approvals, denials } = snapshot();
      const tabs = ['Allow', 'Ask', 'Deny', 'Recently denied'] as const;
      const rows = [
        ...(['allow', 'ask', 'deny'] as const).map(action => groups.flatMap(group =>
          (group.rules[action] ?? []).map(rule => `[${group.label}] ${literal(rule)}`))),
        denials.map(({ tool, reason }) => `${literal(tool)}: ${literal(reason)}`),
      ];
      const summary = `Mode: ${mode} · ${approvals} saved for this session`;
      if (ctx.mode !== 'tui') {
        ctx.ui.notify([summary, ...issues.map(issue => literal(issue)), ...tabs.flatMap((tab, i) => [tab, ...rows[i]!])].join('\n'), invalid ? 'warning' : 'info');
        return;
      }
      await ctx.ui.custom<void>((tui, theme, keys, done) => {
        let tab = 0, first = 0, page = 1;
        return {
          render(width) {
            if (width <= 0) return [];
            page = Math.max(1, Math.min(14, tui.terminal.rows - 8));
            const current = rows[tab]!;
            first = Math.max(0, Math.min(first, current.length - page));
            const headings = tabs.map((name, index) => theme.fg(index === tab ? 'accent' : 'dim', name)).join('  ');
            const lines = [theme.fg('accent', 'Permissions'), summary,
              ...(invalid ? [theme.fg('error', 'Invalid configuration. Tool calls are blocked.'), ...issues.map(issue => literal(issue))] : []),
              '', width >= 37 ? headings : `${tab + 1}/${tabs.length}  ${tabs[tab]}`, glyphs.rule.repeat(width),
              ...(current.length ? current.slice(first, first + page) : ['No entries']),
              ...(current.length > page ? [theme.fg('dim', `${first + 1}-${Math.min(first + page, current.length)}/${current.length}`)] : []),
              '', theme.fg('dim', 'Left/Right or Tab: switch · Up/Down: scroll · Esc: close')];
            return lines.map(line => fit(line, width));
          },
          handleInput(data) {
            if (keys.matches(data, 'tui.select.cancel')) return done(undefined);
            if (matchesKey(data, 'left') || matchesKey(data, 'shift+tab')) { tab = (tab + tabs.length - 1) % tabs.length; first = 0; }
            else if (matchesKey(data, 'right') || keys.matches(data, 'tui.input.tab')) { tab = (tab + 1) % tabs.length; first = 0; }
            else if (keys.matches(data, 'tui.select.up')) first--;
            else if (keys.matches(data, 'tui.select.down')) first++;
            else if (keys.matches(data, 'tui.select.pageUp')) first -= page;
            else if (keys.matches(data, 'tui.select.pageDown')) first += page;
            else return;
            tui.requestRender();
          },
          invalidate() {},
        };
      });
    },
  });
}
