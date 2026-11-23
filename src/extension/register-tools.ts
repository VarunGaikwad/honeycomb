import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { readTodos, TODO_ENTRY } from '../commands/tasks.ts';
import { askQuestion } from './ask-user.ts';
import { createToolSystem } from '../tools/index.ts';
import type { AskResult, ToolContext } from '../types/index.ts';
import type { PermissionController } from './permission-modes/index.ts';
import { decidePermission } from './permission-modes/policy.ts';
import { loadPermissionRules } from './permission-modes/rules.ts';
import { createPermissionPrompter } from '../tui/permission-dialog.ts';
import { literal } from '../tui/text.ts';
import { toolPresentation } from '../tui/tool-renderer.ts';

export function registerTools(pi: ExtensionAPI, permissionModes?: PermissionController): void {
  // Pi supplies the UI context only while executing a tool. Keep the callback
  // injected at registration and bind the current context immediately before dispatch.
  let activeContext: ExtensionContext | undefined;
  const interactive = Boolean(process.stdin.isTTY);
  const prompter = permissionModes?.prompter ?? createPermissionPrompter();
  const { registry, dispatcher } = createToolSystem(interactive ? {
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
  if (permissionModes) pi.registerCommand?.('rewind', {
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
  });

  for (const tool of registry.list()) {
    pi.registerTool({
      name: tool.name,
      label: `🔧 ${tool.name}`,
      description: tool.description,
      ...(tool.promptSnippet ? { promptSnippet: tool.promptSnippet } : {}),
      ...(tool.promptGuidelines ? { promptGuidelines: tool.promptGuidelines } : {}),
      parameters: Type.Unsafe(tool.parameters as never),
      ...(['ask_user', 'todo', 'edit', 'write', 'apply_patch', 'undo'].includes(tool.name) ? { executionMode: 'sequential' as const } : {}),
      ...toolPresentation(tool.name),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
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
        const context: ToolContext = {
          sessionId,
          workingDirectory: ctx.cwd,
          ...(tool.name === 'todo' ? { todoStore: {
            read: () => readTodos(ctx.sessionManager.getBranch()),
            write: items => { if (!signal?.aborted) pi.appendEntry(TODO_ENTRY, items); },
          } } : {}),
          signal,
          confirmDestructive: (operation, target) => confirm(`Confirm ${operation}`, target),
          confirmSensitiveRead: description => confirm('Allow sensitive Git diff?', description),
          confirmCommand: command => confirm('Run shell command?', command),
          ...(['edit', 'write', 'apply_patch', 'undo'].includes(tool.name) ? undoContext(ctx, signal) : {}),
        };
        const result = await dispatcher.dispatch(
          { name: tool.name, arguments: params as Record<string, unknown> },
          context,
        );
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
