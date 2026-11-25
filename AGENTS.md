# Agent guide

## Overview
- Honeycomb extends the Pi coding agent with tools, slash commands, a custom system prompt, and a TUI. It uses TypeScript ES modules and TypeBox. Pi loads `src/index.ts` directly and discovers `themes/*.json` through `package.json`.

## Commands
Run from the repository root with npm and Node.js >=22.19.0 (`package.json` and `package-lock.json`). Pi supplies the optional runtime peers; local checks use the dev dependencies. Results below are local, on Node.js 24.22.2.

| Task | Command | Verification |
| --- | --- | --- |
| Install dev dependencies | `npm install` | Not run; dependencies already present |
| Try one session / install into Pi | `pi -e ./` / `pi install ./` | Requires `pi` on `PATH`; neither run |
| Install and launch the `bee` CLI | `npm install -g .` then `bee` | Requires `pi` on `PATH` to launch; neither run |
| Typecheck `src/` (not tests) | `npm run typecheck` | Passed (`tsc --noEmit`) |
| Run all `tests/**/*.test.ts` | `npm test` | Not run: creates and removes temporary fixtures, uses Git worktrees and POSIX shell processes |
| Run one test file | `node --experimental-transform-types --test tests/commands/goal.test.ts` | Passed (7 tests); substitute another test file to change suites |

- No build, dev-server, lint, or format script is defined. `.prettierrc` records formatting preferences. No CI workflow defines additional commands.

## Architecture
- `bin/bee.js` launches Pi with this extension and forwards session arguments. `src/index.ts` registers the permission controller, tools, prompt and slash commands. On `session_start`, `src/tui/` sets up the header and footer in TUI mode without displacing another extension's editor.
- `createToolSystem()` in `src/tools/index.ts` assembles enabled tool groups into a registry. `src/extension/permission-modes/` gates Pi's `tool_call` event. `src/extension/register-tools.ts` passes the session, cancellation signal and approval callbacks to `ToolDispatcher`, which validates arguments, loads preferences per call, normalizes results and caps output.
- Edit `src/config/bi.config.json` for package defaults (tool groups, limits, UI copy and core instructions). `src/extension/system-instruction.ts` rebuilds the prompt at `before_agent_start`, retaining Pi context and including `systemPrompt.additional` only for trusted projects.
- Goals (`src/commands/goal/`) and todos use custom entries on the current Pi session branch. `agent_before_settle` decides whether to continue a goal within its iteration budget; an active goal turn requires exactly one `goal_report`. Managed process handles and undo history do not survive a branch change.

## Conventions
- Keep TypeScript source and test files under 1000 lines; split by responsibility before approaching the limit. Use explicit `.ts` extensions for relative module imports: both Pi and the Node test runner load source directly.
- Keep authorization in TypeScript: execution requires a command policy or per-command approval; destructive filesystem and Git operations require approval. Slash commands do not pass through `tool_call`; reuse the policy and prompter when accessing protected operations (see `src/commands/diff.ts`).
- Group `node:test` suites by feature under `tests/`. Mock the Pi API to exercise hooks and commands; use temporary repositories for Git behavior.

## Gotchas
- Outside Plan mode, startup creates `.pi/config.json` only if missing (it is tracked here). It may enable quiet startup in the ignored `.pi/settings.json` but preserves explicit settings.
- `src/config/project.ts` allowlists project preferences; they cannot change tool groups or grant permission. Project `.pi/permission-modes.json` is separate and accepts only `ask` and `deny` rules.
- `/init` sends an editing prompt rather than writing a template. It requires an idle agent and confirms regeneration of existing root guidance when a UI is available.
- Web search is opt-in: `--bi-web-search` needs `TAVILY_API_KEY` in the launching shell, not in a project file. It is not a prerequisite for local development.
- The `--bi-*` flags retain their prefix. The Honeycomb themes are `honeycomb-light` and `honeycomb-dark`. Treat `plan/` as design history; check current behavior against the source and tests.
