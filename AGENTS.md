# Agent guide

## Overview
- `bi` is a Pi coding-agent extension package, written in TypeScript/ES modules and integrated with `@earendil-works/pi-coding-agent` and TypeBox.
- Pi loads `src/index.ts` via the `pi.extensions` manifest in `package.json`.

## Commands
Run repository commands from the project root. Node.js `>=22.19.0` is required by `package.json` and the locked Pi dependency.
- Install development dependencies: `npm install` (documented in README; not run during this analysis).
- Use locally for a Pi session: `pi -e ./`; install the extension with Pi: `pi install ./` (requires Pi; not run).
- Tests: `npm test`; single test file: `node --experimental-transform-types --test tests/tools.test.ts` (or substitute `tests/extension.test.ts`). These use built-in Node test runner and TypeScript transform support.
- Typecheck: `npm run typecheck` (`tsc --noEmit`).
- No build, development-server, lint, or format npm scripts are defined. No CI workflows, Makefile/justfile, docs directory, or contribution guide were found.
- Verified locally: `npm test` passed (18 tests) and `npm run typecheck` passed. Install and Pi-specific commands were not run.

## Architecture
- `src/index.ts` registers the extension's tools, `/init` slash command, custom system instruction, and session-start behavior (TUI installation and project-local quiet-startup setting).
- `src/tools/` implements filesystem, execution, Git, agent, and advanced tools. `createToolSystem()` gathers them into a registry; `ToolDispatcher` validates calls, executes them, and normalizes errors/results. `src/extension/register-tools.ts` adapts registry entries to Pi's tool API and supplies UI approval/context.
- `src/slash/` contains slash-command and system-instruction integration; `src/tui/` contains the branded TUI integration; `src/types/` provides shared types.
- `tests/` covers the tool system and extension helpers using Node's test runner.

## Conventions
- Keep TypeScript source and test files under 1000 lines; split responsibilities before approaching that limit (README guidance).
- Use strict TypeScript (`tsconfig.json`); formatting settings are in `.prettierrc`, but no formatter command or dependency is configured.
- Tool execution must retain dispatcher validation/cancellation and the execution/extension approval boundaries. Without UI or configured policy, potentially dangerous shell and destructive filesystem/Git actions are denied.

## Gotchas
- Pi packages are optional peer dependencies at runtime; Pi supplies them. They are also dev dependencies for local typechecking/tests.
- Tests use Node's `--experimental-transform-types`; Node may print its experimental-feature warning.
- `/init` prompts the agent to generate the current project's root `AGENTS.md`; review generated changes carefully. The command checks for existing instructions and requests confirmation before overwriting when UI is available.
- `ensureQuietStartup` manages `.pi/settings.json` under the active project, preserving explicit settings. No `.env.example` or required environment variable/service setup was found.
