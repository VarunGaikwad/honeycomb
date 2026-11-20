import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { BI_CONFIG } from './config/index.ts';
import { ensureProjectConfig, loadProjectConfig } from './config/project.ts';
import { ensureQuietStartup, registerSystemInstruction, registerTools } from './extension/index.ts';
import {
  registerGoalCommand,
  registerInitCommand,
  registerReviewCommand,
  registerSimplifyCommand,
} from './commands/index.ts';
import { installTui } from './tui/index.ts';

// Pi extension entry point.
// Loaded via the "pi.extensions" manifest in package.json.
// Test with: pi -e ./
export default function (pi: ExtensionAPI) {
  registerTools(pi);
  registerSystemInstruction(pi);
  registerInitCommand(pi);
  registerGoalCommand(pi);
  registerReviewCommand(pi);
  registerSimplifyCommand(pi);

  pi.on('session_start', async (_event, ctx) => {
    if (ctx.mode === 'tui') installTui(ctx);
    await ensureProjectConfig(ctx.cwd);
    const projectConfig = await loadProjectConfig(ctx.cwd);
    await ensureQuietStartup(
      ctx.cwd,
      projectConfig.startup?.autoEnableQuietStartup ?? BI_CONFIG.startup.autoEnableQuietStartup,
    );
    ctx.ui.notify(BI_CONFIG.ui.startupMessage, 'info');
  });
}
