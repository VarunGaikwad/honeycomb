import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { LSP_FLAG, resolveLspServer } from '../tools/lsp.ts';
import { literal } from '../tui/text.ts';
import type { PermissionController } from './permission-modes/index.ts';
import { findLspExecutable, installTypeScriptLsp, lspInstallDestination, lspPackages, managedLspServer } from './lsp-install.ts';

const selections = new WeakMap<ExtensionAPI, string>();

export function selectedLspServer(pi: ExtensionAPI, cwd: string) {
  return resolveLspServer(selections.get(pi) ?? pi.getFlag?.(LSP_FLAG), cwd);
}

export function clearLspSelection(pi: ExtensionAPI) {
  selections.delete(pi);
}

export async function needsLspSetup(pi: ExtensionAPI, cwd: string): Promise<boolean> {
  return !await selectedLspServer(pi, cwd) && !await managedLspServer(cwd) && !await findLspExecutable('typescript-language-server', cwd);
}

export function registerLspMenu(pi: ExtensionAPI, permissions: PermissionController, sessionSignal: () => AbortSignal): void {
  let busy = false;
  pi.registerCommand?.('lsp', {
    description: 'Install or enable an optional local language server',
    async handler(args, ctx) {
      if (!ctx.hasUI) return;
      if (busy || args.trim() || ctx.mode !== 'tui' || !ctx.isIdle() || ctx.hasPendingMessages()) {
        return ctx.ui.notify('Use /lsp without arguments while the terminal session is idle.', 'warning');
      }
      const mode = permissions.mode;
      const lifetime = sessionSignal();
      const current = () => !lifetime.aborted && !ctx.signal?.aborted && permissions.mode === mode && ctx.isProjectTrusted() && ctx.isIdle() && !ctx.hasPendingMessages();
      if (['plan', 'dontAsk'].includes(mode) || !ctx.isProjectTrusted()) {
        return ctx.ui.notify('Language server setup needs a trusted workspace outside Plan and No prompts modes.', 'warning');
      }
      busy = true;
      const abort = new AbortController();
      const unsubscribe = permissions.subscribe(() => abort.abort());
      const signal = AbortSignal.any([lifetime, abort.signal, ...(ctx.signal ? [ctx.signal] : [])]);
      const ok = () => !signal.aborted && current();
      try {
        const installed = await managedLspServer(ctx.cwd) ?? await findLspExecutable('typescript-language-server', ctx.cwd);
        const configured = await selectedLspServer(pi, ctx.cwd);
        if (!ok()) return;
        const active = pi.getActiveTools().includes('lsp');
        const entry = `TypeScript / JavaScript — ${installed ? 'Installed' : 'Not installed'}`;
        const existing = 'Use an existing server';
        const title = `Language Servers${active && configured ? ' — server enabled for this session' : ''}`;
        const choice = await ctx.ui.select(title, [entry, existing, 'Close'], { signal });
        if (!ok() || (choice !== entry && choice !== existing)) return;
        let server = installed;
        if (choice === existing) {
          const entered = await ctx.ui.input('Absolute path to an installed --stdio server', configured);
          if (!ok() || !entered?.trim()) return;
          server = await resolveLspServer(entered.trim(), ctx.cwd);
          if (!server) return ctx.ui.notify('Choose an existing executable outside the workspace.', 'warning');
        } else if (!server) {
          const destination = await lspInstallDestination(ctx.cwd);
          const npm = await findLspExecutable('npm', ctx.cwd);
          if (!ok()) return;
          if (process.platform === 'win32' || !destination || !npm) {
            return ctx.ui.notify('Managed install needs macOS/Linux, npm on PATH, and a data folder outside the workspace. You can choose an existing server instead.', 'warning');
          }
          const accepted = await permissions.prompter.confirm(ctx, 'Download and install the TypeScript language server?',
            `${lspPackages.join('\n')}\nSource: https://registry.npmjs.org/\nDestination: ${literal(destination)}\nInstaller: ${literal(npm)}\nnpm lifecycle scripts are disabled. No project or global packages are changed.`, signal);
          if (!accepted || !ok()) return;
          ctx.ui.notify('Installing the TypeScript language server…', 'info');
          server = await installTypeScriptLsp(ctx.cwd, npm, signal, destination);
        }
        if (!ok() || !server) return;
        await enable(ctx, server);
      } catch {
        if (!signal.aborted) ctx.ui.notify('LSP setup failed. Check npm and the Honeycomb data folder, or choose an existing server.', 'warning');
      } finally {
        unsubscribe();
        busy = false;
      }

      async function enable(context: ExtensionCommandContext, server: string) {
        const accepted = await permissions.prompter.confirm(context, 'Enable this server for the current session?',
          `${literal(server)}\nNothing runs until you approve a language server query. Only use a server you trust.`, signal);
        if (!accepted || !ok() || await resolveLspServer(server, context.cwd) !== server || !ok()) return;
        selections.set(pi, server);
        const tools = pi.getActiveTools();
        if (!tools.includes('lsp')) pi.setActiveTools([...tools, 'lsp']);
        context.ui.notify('Language server enabled for this session. Queries still require approval.', 'info');
      }
    },
  });
}
