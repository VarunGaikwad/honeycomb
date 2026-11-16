import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { askQuestion } from './ask-user.ts';
import { createToolSystem } from '../tools/index.ts';
import type { AskResult, ToolContext } from '../types/index.ts';

export function registerTools(pi: ExtensionAPI): void {
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
      label: tool.name,
      description: tool.description,
      ...(tool.promptSnippet ? { promptSnippet: tool.promptSnippet } : {}),
      ...(tool.promptGuidelines ? { promptGuidelines: tool.promptGuidelines } : {}),
      parameters: Type.Unsafe(tool.parameters as never),
      async execute(toolCallId, params, signal, _onUpdate, ctx) {
        activeContext = ctx;
        const context: ToolContext = {
          sessionId: toolCallId,
          workingDirectory: ctx.cwd,
          signal,
          confirmDestructive: async (operation, target) => {
            if (!ctx.hasUI) return false;
            return ctx.ui.confirm(`Confirm ${operation}`, target);
          },
          confirmCommand: async (command) => {
            if (!ctx.hasUI) return false;
            return ctx.ui.confirm('Run shell command?', command);
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
