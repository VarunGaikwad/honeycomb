import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { readTodos, TODO_ENTRY } from '../commands/tasks.ts';
import { askQuestion } from './ask-user.ts';
import { createToolSystem } from '../tools/index.ts';
import type { AskResult, DispatchResult, ToolContext } from '../types/index.ts';
import type { PermissionController } from './permission-modes/index.ts';
import { decidePermission } from './permission-modes/policy.ts';
import { loadPermissionRules } from './permission-modes/rules.ts';
import { createPermissionPrompter } from '../tui/permission-dialog.ts';
import { literal } from '../tui/text.ts';
import { resolvePermissionPath } from './permission-modes/paths.ts';
import { toolPresentation } from '../tui/tool-renderer.ts';
import { LSP_FLAG, resolveLspServer } from '../tools/lsp.ts';
import { WEB_FETCH_FLAG } from '../tools/web-fetch.ts';
import { getTavilyKey, WEB_SEARCH_FLAG, webSearchSetupTip } from '../tools/web-search.ts';
import { clearLspSelection, registerLspMenu, selectedLspServer } from './lsp-menu.ts';

export function registerTools(pi: ExtensionAPI, permissionModes?: PermissionController): void {
  // Pi supplies the UI context only while executing a tool. Keep the callback
  // injected at registration and bind the current context immediately before dispatch.
  let activeContext: ExtensionContext | undefined;
  const interactive = Boolean(process.stdin.isTTY);
  const prompter = permissionModes?.prompter ?? createPermissionPrompter();
  const { registry, dispatcher, processManager } = createToolSystem(interactive ? {
    askUser: async (questions): Promise<AskResult> => {
      const ctx = activeContext;
      if (!ctx?.hasUI || permissionModes?.mode === 'dontAsk') return { status: 'declined' };
      const answers = [];
      for (const question of questions) {
        const answer = await askQuestion(ctx, question);
        if (!answer) return { status: 'declined' };
        answers.push(answer);
      }
      return { status: 'answered', answers };
    },
  } : {});

  let sessionLifetime = new AbortController();
  const retireProcesses = (renew: boolean) => {
    sessionLifetime.abort();
    processManager.clear();
    if (renew) sessionLifetime = new AbortController();
  };
  if (registry.has('lsp')) {
    pi.registerFlag?.(LSP_FLAG, { type: 'string', description: 'Opt into LSP with an absolute path to a trusted local stdio server' });
    if (permissionModes) registerLspMenu(pi, permissionModes, () => sessionLifetime.signal);
  }
  if (registry.has('web_fetch')) {
    pi.registerFlag?.(WEB_FETCH_FLAG, { type: 'boolean', description: 'Opt into model-initiated public HTTPS fetches with per-request approval' });
  }
  if (registry.has('web_search')) pi.registerFlag?.(WEB_SEARCH_FLAG, {
    type: 'boolean', description: 'Opt into Tavily web search with per-query approval',
  });
  pi.on?.('session_start', async (_event, ctx) => {
    retireProcesses(true);
    clearLspSelection(pi);
    if (registry.has('web_fetch') && permissionModes && ctx.hasUI && ctx.isProjectTrusted?.() &&
        !['plan', 'dontAsk'].includes(permissionModes.mode) && pi.getFlag?.(WEB_FETCH_FLAG) === true) {
      const tools = pi.getActiveTools();
      if (!tools.includes('web_fetch')) pi.setActiveTools([...tools, 'web_fetch']);
    }
    if (registry.has('web_search') && pi.getFlag?.(WEB_SEARCH_FLAG) === true && ctx.hasUI) {
      if (!getTavilyKey()) ctx.ui.notify(webSearchSetupTip, 'warning');
      else if (permissionModes && ctx.isProjectTrusted?.() && !['plan', 'dontAsk'].includes(permissionModes.mode)) {
        const tools = pi.getActiveTools();
        if (!tools.includes('web_search')) pi.setActiveTools([...tools, 'web_search']);
      }
    }
    const flag = pi.getFlag?.(LSP_FLAG);
    if (!flag || !registry.has('lsp') || !permissionModes || permissionModes.mode === 'plan' || !ctx.isProjectTrusted?.()) return;
    const lifetime = sessionLifetime.signal;
    if (!await resolveLspServer(flag, ctx.cwd)) {
      ctx.ui.notify('Bi LSP requires an existing executable outside the workspace.', 'warning');
      return;
    }
    if (lifetime.aborted || (permissionModes.mode as string) === 'plan') return;
    const tools = pi.getActiveTools();
    if (!tools.includes('lsp')) pi.setActiveTools([...tools, 'lsp']);
  });
  pi.on?.('session_tree', () => retireProcesses(true));
  pi.on?.('session_shutdown', () => { clearLspSelection(pi); retireProcesses(false); });

  let undoEpoch = 0;
  if (permissionModes) {
    pi.on?.('session_start', () => { undoEpoch++; });
    pi.on?.('session_tree', () => { undoEpoch++; });
    pi.on?.('session_shutdown', () => { undoEpoch++; });
  }
  const undoContext = (ctx: ExtensionContext, signal?: AbortSignal): Pick<ToolContext, 'undoEpoch' | 'checkUndo' | 'confirmDestructive'> => {
    const epoch = undoEpoch;
    const mode = permissionModes?.mode ?? 'default';
    const checkUndo: NonNullable<ToolContext['checkUndo']> = entries => {
      if (epoch !== undoEpoch || signal?.aborted || !ctx.hasUI || ['plan', 'dontAsk'].includes(mode) || (permissionModes?.mode ?? 'default') !== mode) return false;
      const config = loadPermissionRules(ctx.cwd, () => {});
      if (config.invalid || decidePermission(mode, 'undo', {}, ctx.cwd, config.rules).action === 'deny') return false;
      return entries.every(({ file: path, before }) => before === null ? decidePermission(mode, 'delete', { path }, ctx.cwd, config.rules).action !== 'deny' : ['write', 'edit'].every(tool => decidePermission(mode, tool, tool === 'write' ? { path, content: '' } : { path, old_str: '', new_str: '' }, ctx.cwd, config.rules).action !== 'deny'));
    };
    return { undoEpoch: epoch, checkUndo, confirmDestructive: (operation, targets) => prompter.confirm(ctx, `Confirm ${operation}`, literal(targets, true), signal) };
  };
  const rewindCommand: Parameters<ExtensionAPI['registerCommand']>[1] = {
    description: 'Preview and restore the last tracked Bi file operation',
    async handler(args, ctx) {
      if (!ctx.hasUI) return;
      if (ctx.mode !== 'tui' || args.trim() || !ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify('Use /rewind without arguments in an idle terminal session.', 'warning');
        return;
      }
      if (!registry.has('undo')) return ctx.ui.notify('The Bi agent tool group is disabled.', 'warning');
      const guard = undoContext(ctx);
      const result = await dispatcher.dispatch({ name: 'undo', arguments: {} }, {
        ...guard, workingDirectory: ctx.cwd, sessionId: actualSessionId(ctx), signal: ctx.signal,
        checkUndo: paths => ctx.isIdle() && !ctx.hasPendingMessages() && !!guard.checkUndo?.(paths),
      });
      ctx.ui.notify(result.success ? result.output ?? 'Restored patch.' : result.error ?? 'Restore failed.', result.success ? 'info' : 'warning');
    },
  };
  if (permissionModes) {
    pi.registerCommand?.('rewind', rewindCommand);
    pi.registerCommand?.('checkpoint', { ...rewindCommand, description: 'Alias for /rewind (latest Bi file operation only)' });
  }

  for (const tool of registry.list()) {
    pi.registerTool({
      name: tool.name,
      label: `🔧 ${tool.name}`,
      description: tool.description,
      ...(['lsp', 'web_fetch', 'web_search'].includes(tool.name) ? { defaultActive: false, executionMode: 'sequential' as const } : {}),
      ...(tool.promptSnippet ? { promptSnippet: tool.promptSnippet } : {}),
      ...(tool.promptGuidelines ? { promptGuidelines: tool.promptGuidelines } : {}),
      parameters: Type.Unsafe(tool.parameters as never),
      ...(['ask_user', 'todo', 'edit', 'write', 'apply_patch', 'undo', 'notebook_edit'].includes(tool.name) ? { executionMode: 'sequential' as const } : {}),
      ...toolPresentation(tool.name),
      async execute(toolCallId, params, callSignal, _onUpdate, ctx) {
        const lifetime = ['bash', 'background', 'terminal', 'run_code', 'process', 'kill', 'lsp', 'web_fetch', 'web_search'].includes(tool.name)
          ? sessionLifetime.signal : undefined;
        const signal = lifetime && callSignal ? AbortSignal.any([callSignal, lifetime]) : lifetime ?? callSignal;
        activeContext = ctx;
        let sessionId: string;
        try {
          sessionId = actualSessionId(ctx);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: 'text' as const, text: message }],
            details: { success: false, errorCode: 'INTERNAL_ERROR' },
            isError: true,
          };
        }
        const confirm = async (title: string, text: string) => {
          const mode = permissionModes?.mode;
          if (!ctx.hasUI || mode === 'dontAsk') return false;
          return await prompter.confirm(ctx, title, text, signal) && permissionModes?.mode === mode;
        };
        const notebookEpoch = undoEpoch;
        const notebookMode = permissionModes?.mode;
        const context: ToolContext = {
          sessionId,
          workingDirectory: ctx.cwd,
          ...(tool.name === 'lsp' ? { authorizeLsp: async (file: string) => {
            if (!permissionModes || !ctx.isProjectTrusted?.() || signal?.aborted) return;
            const server = await selectedLspServer(pi, ctx.cwd);
            const args = params as Record<string, unknown>;
            if (!server || signal?.aborted || !ctx.isProjectTrusted?.() || typeof args.path !== 'string' || resolvePermissionPath(ctx.cwd, args.path) !== file) return;
            if (permissionModes.consumeCommitApproval(toolCallId, ctx, args, tool.name, server) === true) return server;
          }, canReadLspLocation: (file: string) => {
            if (!permissionModes || !ctx.isProjectTrusted?.() || signal?.aborted) return false;
            const config = loadPermissionRules(ctx.cwd, () => {});
            return !config.invalid && decidePermission(permissionModes.mode, 'read', { path: file }, ctx.cwd, config.rules).action === 'allow';
          } } : {}),
          ...(tool.name === 'web_fetch' ? { authorizeWebFetch: () =>
            !!permissionModes && ctx.hasUI && !!ctx.isProjectTrusted?.() && !signal?.aborted &&
            pi.getFlag?.(WEB_FETCH_FLAG) === true && pi.getActiveTools().includes('web_fetch') &&
            permissionModes.consumeCommitApproval(toolCallId, ctx, params as Record<string, unknown>, tool.name) === true,
          } : {}),
          ...(tool.name === 'web_search' ? { authorizeWebSearch: () => {
            if (!permissionModes || !ctx.hasUI || !ctx.isProjectTrusted?.() || signal?.aborted ||
                pi.getFlag?.(WEB_SEARCH_FLAG) !== true || !pi.getActiveTools().includes('web_search')) return;
            const key = getTavilyKey();
            if (key && permissionModes.consumeCommitApproval(toolCallId, ctx, params as Record<string, unknown>, tool.name)) return key;
          } } : {}),
          ...(tool.name === 'todo' ? { todoStore: {
            read: () => readTodos(ctx.sessionManager.getBranch()),
            write: items => { if (!signal?.aborted) pi.appendEntry(TODO_ENTRY, items); },
          } } : {}),
          signal,
          confirmDestructive: async (operation, target) => {
            if (tool.name === 'notebook_edit' && operation === 'edit notebook cell') {
              try {
                const args = params as Record<string, unknown>;
                if (signal?.aborted || typeof args.path !== 'string' || resolvePermissionPath(ctx.cwd, args.path) !== target) return false;
                return permissionModes?.consumeCommitApproval(toolCallId, ctx, args, tool.name) === true;
              } catch { return false; }
            }
            if (tool.name === 'delete' && operation === 'delete') {
              try {
                const args = params as Record<string, unknown>;
                if (signal?.aborted || typeof args.path !== 'string' || resolvePermissionPath(ctx.cwd, args.path) !== target) return false;
                return permissionModes?.consumeCommitApproval?.(toolCallId, ctx, args, tool.name) ?? confirm('Confirm delete', target);
              } catch { return false; }
            }
            const gitOperations: Record<string, string> = { git_commit: 'git commit', git_add: 'git add', git_checkout: 'git checkout', git_branch: 'create git branch' };
            if (gitOperations[tool.name] === operation) {
              if (signal?.aborted) return false;
              return permissionModes?.consumeCommitApproval?.(toolCallId, ctx, params as Record<string, unknown>, tool.name)
                ?? confirm(tool.name === 'git_commit' ? 'Commit staged changes?' : `Confirm ${operation}`, target);
            }
            return confirm(`Confirm ${operation}`, target);
          },
          confirmSensitiveRead: description => confirm('Allow sensitive Git diff?', description),
          confirmCommand: command => {
            const args = params as Record<string, unknown>;
            const expected = tool.name === 'terminal' && typeof args.input === 'string'
              ? `Send terminal input to ${args.processId}:\n${args.input}`
              : tool.name === 'run_code' && typeof args.code === 'string'
                ? `node --input-type=module -e '${args.code.replaceAll("'", "'\\''")}'`
                : args.command;
            if (command !== expected || signal?.aborted) return Promise.resolve(false);
            const approved = permissionModes?.consumeCommitApproval?.(toolCallId, ctx, args, tool.name);
            return approved === undefined ? confirm('Run shell command?', command) : Promise.resolve(approved);
          },
          ...(['edit', 'write', 'apply_patch', 'undo'].includes(tool.name) ? undoContext(ctx, signal) : {}),
          ...(tool.name === 'notebook_edit' ? {
            undoEpoch: notebookEpoch,
            checkNotebookEdit: () => {
              if (!notebookMode || notebookEpoch !== undoEpoch || permissionModes?.mode !== notebookMode) return false;
              const config = loadPermissionRules(ctx.cwd, () => {});
              return !config.invalid && decidePermission(notebookMode, tool.name, params, ctx.cwd, config.rules).action === 'ask';
            },
          } : {}),
        };
        const dispatched = await dispatcher.dispatch(
          { name: tool.name, arguments: params as Record<string, unknown> },
          context,
        );
        const result: DispatchResult = lifetime?.aborted
          ? { success: false, error: 'Tool session ended', errorCode: 'OPERATION_CANCELLED' }
          : dispatched;
        return {
          content: [{ type: 'text' as const, text: result.output ?? result.error ?? '' }],
          details: { success: result.success, errorCode: result.errorCode, metadata: result.metadata },
          ...(result.success ? {} : { isError: true }),
        };
      },
    });
  }
}

function actualSessionId(ctx: ExtensionContext): string {
  const sessionManager = (ctx as ExtensionContext | undefined)?.sessionManager as
    | { getSessionId?: () => unknown }
    | undefined;
  if (typeof sessionManager?.getSessionId !== 'function') {
    throw new Error('File tracking unavailable: Pi session manager does not expose getSessionId()');
  }
  let sessionId: unknown;
  try {
    sessionId = sessionManager.getSessionId();
  } catch {
    throw new Error('File tracking unavailable: Pi session ID could not be obtained');
  }
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error('File tracking unavailable: Pi session ID is unavailable');
  }
  return sessionId;
}
