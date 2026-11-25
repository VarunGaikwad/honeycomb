import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export function registerInitCommand(pi: ExtensionAPI) {
  // /init — analyze the codebase and generate AGENTS.md
  pi.registerCommand('init', {
    description: 'Analyze the codebase and generate AGENTS.md',
    handler: async (_args, ctx) => {
      const agentsPath = join(ctx.cwd, 'AGENTS.md');

      // Don't queue the prompt while the agent is mid-run
      if (!ctx.isIdle()) {
        ctx.ui.notify(
          'Agent is busy — wait for the current run to finish, then run /init again.',
          'warning',
        );
        return;
      }

      // AGENTS.md already exists? Ask before overwriting.
      if (existsSync(agentsPath) && ctx.hasUI) {
        const regenerate = await ctx.ui.confirm(
          'AGENTS.md exists',
          'Start analyzing the project to propose an update? The actual file change may still require approval.',
        );
        if (!regenerate) {
          ctx.ui.notify('/init cancelled', 'info');
          return;
        }
      }

      const prompt = [
        'Analyze this repository and create or update only the root AGENTS.md for future coding agents.)',
        '',
        'Inspect:',
        '- README.md, CONTRIBUTING.md, relevant docs/.',
        '- CI workflows, Makefile/justfile, scripts/.',
        '- Manifests, lockfiles, runtime/toolchain version files.',
        '- Lint/format/type configs and .env.example.',
        '- Root/nested AGENTS.md, CLAUDE.md, .cursorrules, .github/copilot-instructions.md.',
        '- Relevant source files and tests.',
        '',
        'Cross-check sources; distinguish local commands from CI-only commands. Report unresolved conflicts. Preserve accurate existing guidance and unrelated user edits; correct demonstrably stale instructions. Keep nested instructions scoped to their directories.',
        '',
        'Include only relevant sections:',
        '1. Overview: purpose and main languages/frameworks.',
        '2. Commands: supported install, dev, build, full/single-test, lint, format, typecheck; include working directories and prerequisites. Never invent commands or syntax.',
        '3. Architecture: entry points, main modules, data/control flow; no directory dumps.',
        '4. Conventions: important patterns not already enforced by tooling.',
        '5. Gotchas: generated files, codegen, required environment variables/services, workspace quirks, version constraints.',
        '',
        'Validate commands against inspected scripts/configs. Execute only safe, non-mutating checks after reviewing definitions and prerequisites. Without permission, do not install dependencies, run auto-fix/format-write or destructive commands, or access external services. Skip commands with unclear effects.',
        '',
        'Distinguish successful execution, observed failure, and configuration-supported commands not run. Claim a command works only after successful execution; failure does not necessarily mean the command is incorrect.',
        '',
        'Use verified facts and concise bullets; aim for under 100 lines without losing essential guidance. Omit speculation, generic advice, and duplicated tooling rules. Never include secrets or real .env values. Do not modify other files or fix unrelated issues.',
        '',
        'Finish by confirming the path and created/updated status, summarizing changes in 2-3 bullets, and separately listing failed/unexecuted commands, unresolved conflicts, and verification limits.',
      ].join('\n');

      ctx.ui.notify('Analyzing codebase — /init prompt sent to agent', 'info');
      pi.sendUserMessage(prompt);
    },
  });
}
