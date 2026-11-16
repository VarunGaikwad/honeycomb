import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { createToolSystem } from './tools/index.ts';
import type { ToolContext } from './tools/types.ts';
import { registerInitCommand } from './slash/init.ts';
import { registerSystemInstruction } from './slash/system-instruction.ts';

function registerTools(pi: ExtensionAPI) {
  const { registry, dispatcher } = createToolSystem();
  for (const tool of registry.list()) {
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      ...(tool.promptSnippet ? { promptSnippet: tool.promptSnippet } : {}),
      ...(tool.promptGuidelines ? { promptGuidelines: tool.promptGuidelines } : {}),
      parameters: Type.Unsafe(tool.parameters as never),
      async execute(toolCallId, params, signal, _onUpdate, ctx) {
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
          askUser: async (question) => {
            if (!ctx.hasUI) throw new Error('User interaction is unavailable');
            return (await ctx.ui.input(question, 'Enter your response')) ?? '';
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

// Pi extension entry point.
// Loaded via the "pi.extensions" manifest in package.json.
// Test with: pi -e ./
export default function (pi: ExtensionAPI) {
  registerTools(pi);
  registerSystemInstruction(pi);
  registerInitCommand(pi);

  pi.on('session_start', async (_event, ctx) => {
    ctx.ui.notify('bi extension loaded', 'info');
  });

}
