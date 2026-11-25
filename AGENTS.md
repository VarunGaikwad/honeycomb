# Agent guide

## Overview
- Honeycomb extends the Pi coding agent with tools, slash commands, a custom system prompt, and a TUI. It uses TypeScript ES modules and TypeBox. Pi loads `src/index.ts` directly and discovers `themes/*.json` through `package.json`.

## Commands
Run these local commands from the repository root with Node.js >=22.19.0. Pi supplies the optional runtime peers; local checks use the dev dependencies.

| Task | Command | Verification |
| --- | --- | --- |
| Install dev dependencies | `npm install` | Documented; not run |
| Try one session / install into Pi | `pi -e ./` / `pi install ./` | Requires Pi; not run |
| Typecheck `src/` (not tests) | `npm run typecheck` | Passed (`tsc --noEmit`) |
| Run all `tests/**/*.test.ts` | `npm test` | Includes filesystem and Git fixtures |
| Run one suite | `node --experimental-transform-types --test tests/commands/goal.test.ts` | Passed; substitute another test file to change suites |

- No build, dev-server, lint, or format script is defined. `.prettierrc` records formatting preferences. No CI workflow defines additional commands.

## Architecture
- `src/index.ts` wires tools, the prompt, `/init`, `/review`, `/simplify`, and `/goal` into Pi. On session start it installs the header/footer in TUI mode and initializes project configuration.
- `createToolSystem()` in `src/tools/index.ts` assembles enabled tool groups into a registry. `src/extension/register-tools.ts` bridges Pi calls and UI callbacks to `ToolDispatcher`, which validates arguments, handles cancellation, and normalizes results.
- Edit `src/config/bi.config.json` for package defaults (including tool groups, limits, UI copy, and core instructions). `src/extension/system-instruction.ts` rebuilds the prompt before each run, retaining Pi context and appending project instructions only for trusted projects.
- `src/commands/goal/` stores goal state on the current session branch. The `agent_before_settle` hook decides whether to continue within the iteration budget; an active turn requires exactly one `goal_report`.

## Conventions
- Keep TypeScript source and test files under 1000 lines; split by responsibility before approaching the limit.
- Keep authorization in TypeScript: execution requires a command policy or per-command approval; destructive filesystem and Git operations require approval. Project config must not bypass these checks.

## Gotchas
- Session startup creates `.pi/config.json` only if missing. Project overrides are allowlisted; tool preferences are reread per call. Quiet startup may update `.pi/settings.json` but preserves explicit settings.
- `/init` sends an editing prompt rather than writing a template. It requires an idle agent and confirms regeneration of existing root guidance when a UI is available.
- The Honeycomb themes are `honeycomb-light` and `honeycomb-dark`.
