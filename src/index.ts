import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { ensureQuietStartup, registerTools } from './extension/index.ts';
import { registerInitCommand, registerSystemInstruction } from './slash/index.ts';
import { installTui } from './tui/index.ts';

// Pi extension entry point.
// Loaded via the "pi.extensions" manifest in package.json.
// Test with: pi -e ./
export default function (pi: ExtensionAPI) {
  registerTools(pi);
  registerSystemInstruction(pi);
  registerInitCommand(pi);

  pi.on('session_start', async (_event, ctx) => {
    if (ctx.mode === 'tui') installTui(ctx);
    await ensureQuietStartup(ctx.cwd);
    ctx.ui.notify('bi extension loaded', 'info');
  });
}
