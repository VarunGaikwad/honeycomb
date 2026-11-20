import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export function registerReviewCommand(pi: ExtensionAPI) {
  pi.registerCommand('review', {
    description: 'Review the current changes for defects',
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify('Agent is busy — wait for the current run to finish, then try /review again.', 'warning');
        return;
      }

      const focus = args.trim();
      pi.sendUserMessage([
        'Review the current working-tree changes for correctness, regressions, security issues, and missing tests.',
        focus ? `Pay particular attention to: ${focus}` : '',
        '',
        'Inspect the diff and enough surrounding code to verify behavior. Do not modify files. Report only actionable findings, ordered by severity, with file and line references and a concise explanation. If you find no issues, say so and mention any relevant verification limits. Do not report speculative concerns as confirmed defects.',
      ].filter(Boolean).join('\n'));
    },
  });
}
