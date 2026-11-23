import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { matchesKey } from '@earendil-works/pi-tui';
import type { PermissionController } from '../extension/permission-modes/index.ts';
import { decidePermission } from '../extension/permission-modes/policy.ts';
import { loadPermissionRules } from '../extension/permission-modes/rules.ts';
import { runDiff } from '../tools/git.ts';
import { fit, literal } from '../tui/text.ts';

type File = { status: string; paths: string[] };
type Action = 'switch' | 'back' | 'sensitive' | number | undefined;

export function registerDiffCommand(pi: ExtensionAPI, permissions: PermissionController): void {
  pi.registerCommand('diff', {
    description: 'Browse staged and unstaged Git changes without a model call',
    async handler(args, ctx) {
      if (ctx.mode !== 'tui' || !ctx.hasUI) {
        if (ctx.hasUI) ctx.ui.notify('/diff requires the terminal UI.', 'warning');
        return;
      }
      const idle = () => ctx.isIdle() && !ctx.hasPendingMessages();
      if (!idle()) return ctx.ui.notify('Wait for the current run before opening /diff.', 'warning');
      const input = args.trim();
      if (input && input !== 'staged' && input !== 'unstaged') return ctx.ui.notify('Usage: /diff [staged|unstaged]', 'warning');
      let staged = input === 'staged';
      const mode = permissions.mode;
      const leaf = ctx.sessionManager.getLeafId();
      const sessionId = ctx.sessionManager.getSessionId();
      const current = () => permissions.mode === mode && idle() && ctx.sessionManager.getLeafId() === leaf && ctx.sessionManager.getSessionId() === sessionId;
      let files: File[] = [], selected = 0, picking = true, sensitiveApproved = false;
      let approval: string | undefined;
      while (current()) {
        const decision = () => {
          const config = loadPermissionRules(ctx.cwd, () => {});
          return config.invalid ? { action: 'deny', reason: 'Invalid permission rules. See /permissions.' } : decidePermission(mode, 'git_diff', { staged }, ctx.cwd, config.rules);
        };
        const initial = decision();
        const scope = JSON.stringify([staged, initial]);
        const check = () => current() && JSON.stringify([staged, decision()]) === scope;
        if (initial.action === 'ask' && approval !== scope && mode !== 'dontAsk') {
          if (await permissions.prompter.confirm(ctx, 'Open Git diff?', initial.reason) && check()) approval = scope;
          else return;
        }
        if (!current()) return;
        const abort = new AbortController();
        let sensitive: string | undefined;
        const file = picking ? undefined : files[selected];
        const action = await ctx.ui.custom<Action>((tui, theme, keys, done) => {
          let rows = ['Loading changes…'], loaded = false, offset = 0, page = 1;
          const close = (next: Action) => { abort.abort(); done(next); };
          const update = async () => {
            try {
              if (!check() || (initial.action !== 'allow' && approval !== scope)) rows = [literal(initial.reason)];
              else {
                const value = await runDiff({ workingDirectory: ctx.cwd, sessionId, signal: abort.signal,
                  confirmSensitiveRead: async description => { sensitive = description; return sensitiveApproved && check(); },
                }, staged, file ? { paths: file.paths } : { list: true });
                if (abort.signal.aborted) return;
                if (!check()) rows = ['Permission context changed.'];
                else if (sensitive && !sensitiveApproved && mode !== 'dontAsk') return close('sensitive');
                else if (!value.success) rows = [literal(value.error ?? 'Unable to load diff.')];
                else if (picking) {
                  files = (value.metadata?.files as File[] | undefined) ?? [];
                  selected = Math.max(0, Math.min(selected, files.length - 1));
                  rows = files.length ? [] : ['No changes.'];
                } else rows = (value.output || 'No changes.').split('\n').map(line => literal(line));
              }
            } catch { rows = ['Unable to inspect Git diff.']; }
            loaded = true;
            if (!abort.signal.aborted) tui.requestRender();
          };
          queueMicrotask(() => { if (!abort.signal.aborted) void update(); });
          return {
            render(width) {
              page = Math.max(1, tui.terminal.rows - 6);
              const list = loaded && picking && !rows.length && files.length > 0;
              if (list) offset = Math.max(0, Math.min(offset, selected));
              if (list && selected >= offset + page) offset = selected - page + 1;
              if (!list) offset = Math.max(0, Math.min(offset, rows.length - page));
              const body = list ? files.slice(offset, offset + page).map(({ paths, status }, i) => {
                const title = `${status} ${paths.map(name => literal(name)).join(' → ')}`;
                return offset + i === selected ? theme.fg('accent', `> ${title}`) : `  ${title}`;
              }) : rows.slice(offset, offset + page);
              return [theme.fg('accent', `Git diff — ${staged ? 'staged' : 'unstaged'}`), 'Tracked files only; submodules omitted.', ...body,
                picking ? 'Tab: switch · ↑/↓: select · Enter: open · Esc: close' : 'Tab: switch · ↑/↓/PgUp/PgDn: scroll · n/p: file · Esc: back'].map(line => fit(line, width));
            },
            handleInput(data) {
              if (keys.matches(data, 'tui.select.cancel')) return close(picking ? undefined : 'back');
              if (keys.matches(data, 'tui.input.tab')) return close('switch');
              if (!loaded || !check()) return;
              if (picking && !rows.length && keys.matches(data, 'tui.select.confirm')) return close(selected);
              if (!picking && (matchesKey(data, 'n') || matchesKey(data, 'p'))) return close(Math.max(0, Math.min(files.length - 1, selected + (matchesKey(data, 'n') ? 1 : -1))));
              const delta = keys.matches(data, 'tui.select.up') ? -1 : keys.matches(data, 'tui.select.down') ? 1 :
                keys.matches(data, 'tui.select.pageUp') ? -page : keys.matches(data, 'tui.select.pageDown') ? page : 0;
              if (!delta) return;
              if (picking && !rows.length) selected = Math.max(0, Math.min(files.length - 1, selected + delta));
              else offset += delta;
              tui.requestRender();
            },
            invalidate() {},
          };
        });
        abort.abort();
        if (action === undefined) return;
        if (action === 'sensitive') {
          if (!await permissions.prompter.confirm(ctx, 'Allow sensitive Git diff?', sensitive!) || !check()) return;
          sensitiveApproved = true;
          continue;
        }
        sensitiveApproved = false;
        if (action === 'switch') { staged = !staged; approval = undefined; files = []; selected = 0; picking = true; }
        else if (action === 'back') picking = true;
        else { selected = action; picking = false; }
      }
    },
  });
}
