import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { PermissionController } from '../extension/permission-modes/index.ts';

export function registerVerifyCommand(pi: ExtensionAPI, permissions: PermissionController): void {
  pi.registerCommand('verify', {
    description: 'Inspect and run permitted project checks without making fixes',
    handler: async (args, ctx) => {
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify('Wait for the current run and queued input before using /verify.', 'warning');
        return;
      }
      const focus = args.trim();
      pi.sendUserMessage([
        'Verify the current project changes. Identify relevant supported checks and inspect their definitions before proposing or running them.',
        permissions.mode === 'plan' ? 'Plan mode is active: propose checks only; do not execute them.' : 'Run relevant checks only when existing permission policy permits. Do not install dependencies, access the network, request elevated permissions, or make fixes.',
        'Report each check as passed, failed, or not run, with evidence and limitations. Never claim a check ran without evidence. Preserve any active goal reporting requirements.',
        focus ? `User focus: ${focus}` : '',
      ].filter(Boolean).join('\n'));
    },
  });
}
