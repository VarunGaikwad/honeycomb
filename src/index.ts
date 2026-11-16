import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerInitCommand } from './slash/init.ts';
import { registerSystemInstruction } from './slash/system-instruction.ts';

// Pi extension entry point.
// Loaded via the "pi.extensions" manifest in package.json.
// Test with: pi -e ./
export default function (pi: ExtensionAPI) {
  registerSystemInstruction(pi);
  registerInitCommand(pi);

  pi.on('session_start', async (_event, ctx) => {
    ctx.ui.notify('bi extension loaded', 'info');
  });

}
