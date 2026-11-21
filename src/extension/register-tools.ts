import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { askQuestion } from './ask-user.ts';
import { createToolSystem } from '../tools/index.ts';
import type { AskResult, ToolContext } from '../types/index.ts';
import type { PermissionController } from './permission-modes/index.ts';

export function registerTools(pi: ExtensionAPI, permissionModes?: PermissionController): void {
  // Pi supplies the UI context only while executing a tool. Keep the callback
  // injected at registration and bind the current context immediately before dispatch.
  let activeContext: ExtensionContext | undefined;
  const interactive = Boolean(process.stdin.isTTY);
  const { registry, dispatcher } = createToolSystem(interactive ? {
    askUser: async (questions): Promise<AskResult> => {
      const ctx = activeContext;
      if (!ctx?.hasUI) return { status: 'declined' };
      const answers = [];
      for (const question of questions) {
        const answer = await askQuestion(ctx, question);
        if (!answer) return { status: 'declined' };
        answers.push(answer);
      }
      return { status: 'answered', answers };
    },
  } : {});

  for (const tool of registry.list()) {
    pi.registerTool({
      name: tool.name,
      label: `🔧 ${tool.name}`,
      description: tool.description,
      ...(tool.promptSnippet ? { promptSnippet: tool.promptSnippet } : {}),
      ...(tool.promptGuidelines ? { promptGuidelines: tool.promptGuidelines } : {}),
      parameters: Type.Unsafe(tool.parameters as never),
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
        const context: ToolContext = {
          sessionId,
          workingDirectory: ctx.cwd,
          signal,
          confirmDestructive: async (operation, target) => {
            if (!ctx.hasUI || permissionModes?.mode === 'dontAsk') return false;
            try { return await ctx.ui.confirm(`Confirm ${operation}`, target); } catch { return false; }
          },
          confirmCommand: async (command) => {
            if (!ctx.hasUI || permissionModes?.mode === 'dontAsk') return false;
            try { return await ctx.ui.confirm('Run shell command?', command); } catch { return false; }
          },
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
