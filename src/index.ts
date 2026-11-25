import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { BI_CONFIG } from './config/index.ts';
import { ensureProjectConfig, loadProjectConfig } from './config/project.ts';
import { ensureQuietStartup, registerSystemInstruction, registerTools } from './extension/index.ts';
import {
  registerBtwCommand,
  registerDiffCommand,
  registerDiscoveryCommands,
  registerDoctorCommand,
  registerGoalCommand,
  registerInitCommand,
  registerPlanCommand,
  registerReviewCommand,
  registerSecurityReviewCommand,
  registerSimplifyCommand,
  registerTasksCommand,
  registerVerifyCommand,
  registerWorktreeCommand,
} from './commands/index.ts';
import { installTui } from './tui/index.ts';
import { registerWorkingFeedback } from './tui/working-feedback.ts';
import { createPermissionModes } from './extension/permission-modes/index.ts';

// Pi extension entry point.
// Loaded via the "pi.extensions" manifest in package.json.
// Test with: pi -e ./
export default function (pi: ExtensionAPI) {
  const permissionModes = createPermissionModes(pi);
  registerTools(pi, permissionModes);
  registerSystemInstruction(pi, permissionModes);
  registerBtwCommand(pi, permissionModes);
  registerDiffCommand(pi, permissionModes);
  registerDiscoveryCommands(pi, permissionModes);
  registerDoctorCommand(pi, permissionModes);
  registerInitCommand(pi);
  registerPlanCommand(pi, permissionModes);
  registerGoalCommand(pi);
  registerReviewCommand(pi);
  registerSecurityReviewCommand(pi, permissionModes);
  registerSimplifyCommand(pi);
  registerTasksCommand(pi);
  registerVerifyCommand(pi, permissionModes);
  registerWorktreeCommand(pi, permissionModes);
  registerWorkingFeedback(pi);

  pi.on('session_start', async (_event, ctx) => {
    if (ctx.mode === 'tui') {
      const config = await loadProjectConfig(ctx.cwd);
      installTui(ctx, permissionModes, config.ui?.footerStyle ?? BI_CONFIG.ui.footerStyle);
    }
    if (permissionModes.mode !== 'plan') {
      await ensureProjectConfig(ctx.cwd);
      const projectConfig = await loadProjectConfig(ctx.cwd);
      await ensureQuietStartup(
        ctx.cwd,
        projectConfig.startup?.autoEnableQuietStartup ?? BI_CONFIG.startup.autoEnableQuietStartup,
      );
    }
    if (ctx.mode !== 'tui') ctx.ui.notify(BI_CONFIG.ui.startupMessage, 'info');
  });
}
