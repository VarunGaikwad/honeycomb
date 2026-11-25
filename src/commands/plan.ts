import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { PermissionController } from '../extension/permission-modes/index.ts';
import { planNotePath, readPlanNote } from '../extension/permission-modes/plan-note.ts';
import { loadPermissionRules } from '../extension/permission-modes/rules.ts';
import { decidePermission } from '../extension/permission-modes/policy.ts';
import { show } from './discovery.ts';

export function registerPlanCommand(pi: ExtensionAPI, permissions: PermissionController): void {
  pi.registerCommand('plan', {
    description: 'Enter Plan mode, start planning a request, or show the session note',
    async handler(args, ctx) {
      if (ctx.mode !== 'tui' || !ctx.hasUI) return;
      if (!ctx.isIdle() || ctx.hasPendingMessages()) return ctx.ui.notify('Wait for the current run and queued input before /plan.', 'warning');
      const request = args.trim();
      if (request === 'show' || (!request && permissions.mode === 'plan')) {
        try {
          const session = ctx.sessionManager.getSessionId();
          const leaf = ctx.sessionManager.getLeafId();
          const path = planNotePath(ctx.cwd, session);
          const rules = loadPermissionRules(ctx.cwd, () => {});
          if (rules.invalid || decidePermission(permissions.mode, 'read', { path }, ctx.cwd, rules.rules).action !== 'allow') {
            return ctx.ui.notify('Plan note cannot be displayed under the current permission rules.', 'warning');
          }
          const note = await readPlanNote(ctx.cwd, session);
          const currentRules = loadPermissionRules(ctx.cwd, () => {});
          if (ctx.sessionManager.getSessionId() !== session || ctx.sessionManager.getLeafId() !== leaf || !ctx.isIdle() || ctx.hasPendingMessages() || currentRules.invalid || decidePermission(permissions.mode, 'read', { path }, ctx.cwd, currentRules.rules).action !== 'allow') return;
          await show(ctx, 'Session plan', note ? note.split('\n') : ['No saved plan note.']);
        } catch { ctx.ui.notify('Unable to read the session plan note safely.', 'warning'); }
        return;
      }
      if (!permissions.enterPlan()) return ctx.ui.notify('Cannot enter Plan from the current permission mode.', 'warning');
      if (request) pi.sendUserMessage(`Create a plan for the following request. Inspect relevant context and save the plan with plan_note. Do not implement it.\n\n${request}`);
      else ctx.ui.notify('Plan mode enabled.', 'info');
    },
  });
}
