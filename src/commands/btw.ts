import { randomUUID } from 'node:crypto';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { PermissionController } from '../extension/permission-modes/index.ts';
import { fit, literal } from '../tui/text.ts';

export function registerBtwCommand(pi: ExtensionAPI, permissions: PermissionController, timeoutMs = 30_000): void {
  let running: AbortController | undefined;
  pi.on('session_shutdown', () => running?.abort());
  pi.registerCommand('btw', {
    description: 'Ask a separate, tool-free question using the active model',
    async handler(args, ctx) {
      if (ctx.mode !== 'tui' || !ctx.hasUI) {
        if (ctx.hasUI) ctx.ui.notify('/btw requires the terminal UI.', 'warning');
        return;
      }
      const available = () => ctx.isIdle() && !ctx.hasPendingMessages() && !['plan', 'dontAsk'].includes(permissions.mode);
      if (!available() || running) return ctx.ui.notify('/btw requires an idle session outside Plan and No prompts modes.', 'warning');
      const model = ctx.model;
      if (!model) return ctx.ui.notify('Select a model before using /btw.', 'warning');
      const question = (args.trim() || await ctx.ui.input('Side question (not added to the main transcript)'))?.trim();
      if (!question) return;
      if (question.length > 4000) return ctx.ui.notify('Side questions are limited to 4,000 characters.', 'warning');
      if (!available() || running) return;
      const controller = new AbortController();
      running = controller;
      try {
        const label = literal(`${model.provider}/${model.id}`);
        const send = await permissions.prompter.confirm(ctx, 'Send side question?', `${label} will receive only this question. Provider retention policies apply.\n\n${literal(question, true)}`, controller.signal);
        if (!send || !available() || controller.signal.aborted) return;
        await ctx.ui.custom<void>((tui, theme, keys, done) => {
          let reply = '', status = 'Waiting for the model…', offset = 0, page = 1;
          const timeout = setTimeout(() => {
            controller.abort();
            status = 'Request timed out.';
            tui.requestRender();
          }, timeoutMs);
          const request = async () => {
            try {
              const stream = ctx.modelRegistry.streamSimple(model, {
                systemPrompt: 'Answer this standalone question concisely. If context is missing, say so.',
                messages: [{ role: 'user', content: question, timestamp: Date.now() }], tools: [],
              }, { signal: controller.signal, sessionId: randomUUID(), cacheRetention: 'none', disableContinuation: true, maxTokens: 512, maxRetries: 0 });
              for await (const event of stream) {
                if (controller.signal.aborted) return;
                if (event.type === 'text_delta') {
                  reply = (reply + event.delta).slice(0, 16000);
                  tui.requestRender();
                }
              }
              const result = await stream.result();
              if (controller.signal.aborted) return;
              const usage = result.usage;
              const cost = usage?.cost?.total;
              status = result.stopReason === 'error' || result.stopReason === 'aborted' ? 'Request failed. Check model access and provider status.' :
                `${usage?.totalTokens ?? 'Unknown'} tokens · ${typeof cost === 'number' && Number.isFinite(cost) ? `estimated $${cost.toFixed(4)}` : 'cost unavailable'}`;
              if (!reply && result.stopReason !== 'error') reply = 'No text answer returned.';
              tui.requestRender();
            } catch {
              if (!controller.signal.aborted) {
                status = 'Request failed. Check model access and provider status.';
                tui.requestRender();
              }
            } finally { clearTimeout(timeout); }
          };
          queueMicrotask(() => { if (!controller.signal.aborted) void request(); else clearTimeout(timeout); });
          return {
            render(width) {
              page = Math.max(1, tui.terminal.rows - 6);
              const lines = literal(reply, true).split('\n');
              offset = Math.max(0, Math.min(offset, lines.length - 1));
              return [theme.fg('accent', `Side question · ${label}`), status, ...lines.slice(offset, offset + page), '↑/↓/PgUp/PgDn: scroll · Esc: close'].map(line => fit(line, width));
            },
            handleInput(data) {
              if (keys.matches(data, 'tui.select.cancel')) {
                clearTimeout(timeout);
                controller.abort();
                return done(undefined);
              }
              if (keys.matches(data, 'tui.select.up')) offset--;
              else if (keys.matches(data, 'tui.select.down')) offset++;
              else if (keys.matches(data, 'tui.select.pageUp')) offset -= page;
              else if (keys.matches(data, 'tui.select.pageDown')) offset += page;
              else return;
              tui.requestRender();
            },
            invalidate() {},
          };
        }, { overlay: true });
      } finally {
        controller.abort();
        running = undefined;
      }
    },
  });
}
