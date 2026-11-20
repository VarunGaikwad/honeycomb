import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export function registerSimplifyCommand(pi: ExtensionAPI) {
  pi.registerCommand('simplify', {
    description: 'Simplify the current changes without changing behavior',
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify('Agent is busy — wait for the current run to finish, then try /simplify again.', 'warning');
        return;
      }

      const focus = args.trim();
      pi.sendUserMessage([
        'Inspect the current working-tree changes and simplify the relevant implementation while preserving behavior.',
        focus ? `Focus on: ${focus}` : '',
        '',
        'Prefer clear, direct code and existing project conventions. Avoid unrelated refactors, new dependencies, and changes to public behavior. Make a change only when there is a concrete simplification; then run appropriate tests or checks and summarize what changed and what was verified.',
      ].filter(Boolean).join('\n'));
    },
  });
}
