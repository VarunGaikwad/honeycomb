import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { PermissionController } from '../extension/permission-modes/index.ts';
import { decidePermission } from '../extension/permission-modes/policy.ts';
import { loadPermissionRules } from '../extension/permission-modes/rules.ts';
import { runDiff } from '../tools/git.ts';
import { fit, literal } from '../tui/text.ts';

export function registerSecurityReviewCommand(pi: ExtensionAPI, permissions: PermissionController): void {
  let running: AbortController | undefined;
  let generation = 0;
  pi.on('session_shutdown', () => { generation++; running?.abort(); });
  pi.on('session_tree', () => { generation++; running?.abort(); });
  pi.registerCommand('security-review', {
    description: 'Review an explicitly selected local diff with a tool-free model request',
    async handler(args, ctx) {
      if (ctx.mode !== 'tui' || !ctx.hasUI) return;
      const input = args.trim();
      if (input !== 'staged' && input !== 'unstaged') return ctx.ui.notify('Usage: /security-review staged|unstaged', 'warning');
      const mode = permissions.mode, session = ctx.sessionManager.getSessionId(), leaf = ctx.sessionManager.getLeafId(), model = ctx.model, started = generation;
      const valid = () => generation === started && !running && ctx.isIdle() && !ctx.hasPendingMessages() && permissions.mode === mode && !['plan', 'dontAsk'].includes(mode) && ctx.sessionManager.getSessionId() === session && ctx.sessionManager.getLeafId() === leaf && ctx.model === model;
      if (!valid() || !model) return ctx.ui.notify('An idle session, selected model, and interactive permission mode are required.', 'warning');
      const staged = input === 'staged';
      const allowed = () => { const rules = loadPermissionRules(ctx.cwd, () => {}); return !rules.invalid && decidePermission(mode, 'git_diff', { staged }, ctx.cwd, rules.rules).action === 'allow'; };
      if (!allowed()) return ctx.ui.notify('Diff access is not automatically allowed by current rules; use /diff instead.', 'warning');
      let result;
      let paths: string[] = [];
      const pathsAllowed = () => {
        const rules = loadPermissionRules(ctx.cwd, () => {});
        return !rules.invalid && paths.every(file => decidePermission(mode, 'read', { path: file }, ctx.cwd, rules.rules).action === 'allow');
      };
      try {
        const context = { workingDirectory: ctx.cwd, sessionId: session, confirmSensitiveRead: async () => false };
        const listing = await runDiff(context, staged, { list: true });
        if (!listing.success) return ctx.ui.notify(listing.error === 'Sensitive diff was not approved'
          ? 'The selected diff includes protected or unclassifiable paths. Unstage those files before running /security-review.'
          : 'Unable to inspect diff paths safely.', 'warning');
        if (!valid() || !allowed()) return;
        const files = listing.metadata?.files as { paths: string[] }[] | undefined;
        const root = listing.metadata?.root;
        if (!files || typeof root !== 'string') return ctx.ui.notify('Unable to identify diff paths.', 'warning');
        if (!files.length) return ctx.ui.notify(`No ${input} tracked changes to review. Committed changes are not included.`, 'info');
        paths = files.flatMap(file => file.paths.map(name => path.resolve(root, name)));
        if (!pathsAllowed()) return ctx.ui.notify('A diff path is not allowed by current read rules.', 'warning');
        result = await runDiff(context, staged);
        const after = await runDiff(context, staged, { list: true });
        if (!after.success || JSON.stringify(after.metadata?.files) !== JSON.stringify(files)) return ctx.ui.notify('Diff paths changed during review.', 'warning');
      }
      catch { return ctx.ui.notify('Unable to load the selected diff.', 'warning'); }
      if (!valid() || !allowed()) return;
      if (!result.success) return ctx.ui.notify('Unable to load the selected diff safely. Protected or oversized diffs are not sent.', 'warning');
      const diff = result.output ?? '';
      if (!diff.trim() || Buffer.byteLength(diff) > 12000) return ctx.ui.notify('The diff is empty or exceeds the 12 KB review limit.', 'warning');
      const approved = await permissions.prompter.confirm(ctx, 'Send local diff for security review?', `${literal(model.provider + '/' + model.id)} receives this ${input} diff. Provider retention policies apply. No conversation or tools are sent.\n\n${literal(diff, true)}`);
      if (!approved || !valid() || !allowed() || !pathsAllowed()) return;
      const controller = new AbortController(); running = controller;
      try {
        await ctx.ui.custom<void>((tui, theme, keys, done) => {
          let reply = '', status = 'Reviewing…', offset = 0, page = 1;
          const timer = setTimeout(() => { controller.abort(); status = 'Request timed out.'; tui.requestRender(); }, 30000);
          queueMicrotask(async () => {
            try {
              if (controller.signal.aborted) return;
              const stream = ctx.modelRegistry.streamSimple(model, {
                systemPrompt: 'Review the supplied diff for actionable security defects. Give severity, relevant line references where available, remediation, and scope limitations. Do not claim to have inspected anything else. Do not generate exploits.',
                messages: [{ role: 'user', content: diff, timestamp: Date.now() }], tools: [],
              }, { signal: controller.signal, sessionId: randomUUID(), cacheRetention: 'none', disableContinuation: true, maxTokens: 1024, maxRetries: 0 });
              for await (const event of stream) { if (controller.signal.aborted) return; if (event.type === 'text_delta') { reply = (reply + event.delta).slice(0, 16000); tui.requestRender(); } }
              const answer = await stream.result();
              if (!controller.signal.aborted) { status = answer.stopReason === 'error' || answer.stopReason === 'aborted' ? 'Review failed.' : answer.stopReason === 'toolUse' ? 'Review incomplete: unexpected tool request was ignored.' : 'Review complete; findings are model-generated.'; tui.requestRender(); }
            } catch { if (!controller.signal.aborted) { status = 'Review failed.'; tui.requestRender(); } }
            finally { clearTimeout(timer); }
          });
          return {
            render(width) { page = Math.max(1, tui.terminal.rows - 6); const rows = literal(reply, true).split('\n'); offset = Math.max(0, Math.min(offset, rows.length - 1)); return [theme.fg('accent', 'Security review'), status, ...rows.slice(offset, offset + page), '↑/↓/PgUp/PgDn: scroll · Esc: close'].map(line => fit(line, width)); },
            handleInput(data) { if (keys.matches(data, 'tui.select.cancel')) { controller.abort(); clearTimeout(timer); return done(undefined); } if (keys.matches(data, 'tui.select.up')) offset--; else if (keys.matches(data, 'tui.select.down')) offset++; else if (keys.matches(data, 'tui.select.pageUp')) offset -= page; else if (keys.matches(data, 'tui.select.pageDown')) offset += page; else return; tui.requestRender(); },
            invalidate() {},
          };
        });
      } finally { controller.abort(); running = undefined; }
    },
  });
}
