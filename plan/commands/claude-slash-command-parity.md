# Claude Code slash-command parity for Bi

**Status: proposed; no runtime changes.** Audit scope: local `temp/` mirror (`a371abb`) and Bi's working tree. This is a static inventory, not a list of commands available to every Claude Code user. Use independently written Bi code and prompts based on public behavior and Pi APIs. Do not copy prompt text, import from `temp/`, or ship the mirror.

**First release:** `/plan`, `/context`, `/help`, `/skills`, `/status`. Keep Bi's existing commands and let Pi own its built-ins. Add workflows such as `/verify` and `/security-review` separately because they involve a model or tool execution.

## Prompt inventory and comparison

| Layer | Claude snapshot | Bi today / parity decision |
| --- | --- | --- |
| System prompt | `temp/src/constants/prompts.ts` builds identity, workflow, tone, and tool guidance, then adds session-specific sections such as skills, environment, language, output style, memory, and MCP. `constants/systemPromptSections.ts` manages dynamic sections; `utils/systemPrompt.ts` handles replacement/override and append precedence. | `src/config/bi.config.json` owns the short core; `src/extension/system-instruction.ts` rebuilds it before each run with Pi's custom prefix/append text, active visible tools, context files, skills, extra sections, and current permission mode. Keep this composition and precedence; don't add the entire slash catalog to the system prompt. |
| Project instructions | `temp/src/context.ts` gathers `CLAUDE.md`-style instructions/date and optional Git context. `/init` generates Claude project guidance. | Bi `/init` targets root `AGENTS.md`, and Pi already recognizes `CLAUDE.md` as a context-file fallback. `.pi/config.json` `systemPrompt.additional` is bounded and applies only to trusted projects. No second loader or automatic Git/context injection needed. |
| Tool guidance | 36 `temp/src/tools/*/prompt.ts` files, including filesystem/search/shell, plan/worktree, agent/task/team, skills/MCP, scheduling, and web prompts. They aren't slash commands. | Bi registers tool descriptions and optional `promptSnippet`/`promptGuidelines` via `src/extension/register-tools.ts`. Improve guidance tool by tool when needed; permissions stay in TypeScript. |
| Slash prompts | The main registry's `prompt` commands are `/init`, `/review`, `/security-review`, `/pr-comments`, `/insights`, and `/statusline`. Internal prompt entries: `/commit`, `/commit-push-pr`, and `/init-verifiers`. Claude also has prompt-backed skills (listed below) and `local`/`local-jsx` handlers, which aren't prompt templates. | `/init`, `/review`, and `/simplify` send focused user prompts. `/goal` has its own start/continuation prompt and `goal_report` checks; `/btw` makes a separate, tool-free model request. Add workflow instructions only when the user invokes the command, not on every turn. |
| Task-specific and service prompts | `temp/src/tools/AgentTool/built-in/` supplies explore, plan, general-purpose, guide, verification, and statusline setup agent definitions. `temp/src/services/` has prompts for compaction (`compact/prompt.ts`), memory (`SessionMemory/prompts.ts`, `extractMemories/prompts.ts`, `autoDream/consolidationPrompt.ts`), input suggestions (`PromptSuggestion/promptSuggestion.ts`), and document updates (`MagicDocs/prompts.ts`). | Use Pi compaction and Bi's current agent. No new subagent engine, background memory extraction, hidden session uploads, or proactive loops as part of slash parity. |

## Slash inventory and disposition

Source of truth: `temp/src/commands.ts` plus `temp/src/skills/bundled/index.ts`. There are **75 concrete canonical names in the main registry** after deduplicating `/context` and `/extra-usage` variants and excluding missing modules/internal entries, **6 more concrete internal names**, and **14 named bundled skills with code present**. This counts declarations, including hidden and gated ones, not runtime availability. Project/user commands and skills, plugins, workflows, and MCP can contribute other names at runtime.

### Main registry: all 75 named entries

| Decision | Claude command names | Bi behavior or mapping |
| --- | --- | --- |
| Keep: already in Bi | `/btw`, `/diff`, `/doctor`, `/init`, `/permissions`, `/review`, `/rewind`, `/tasks` | No duplicate registrations. See differences below. |
| Use Pi's exact command | `/compact`, `/copy`, `/export`, `/login`, `/logout`, `/model`, `/resume` | Already available in Pi's TUI. These aren't Bi commands and need not match every argument or provider behavior. |
| Reserved name, different meaning | `/session` | Claude snapshot: remote URL/QR. Pi: local session info and stats. Keep Pi's meaning. |
| Use Pi equivalents | `/branch`, `/clear`, `/config`, `/cost`, `/effort`, `/exit`, `/keybindings`, `/release-notes`, `/reload-plugins`, `/rename`, `/theme` | `/clone` (branch at current point; `/tree` or `/fork` for other history operations), `/new`, `/settings`, `/session`, `/thinking`, `/quit`, `/hotkeys` + keybindings config, `/changelog`, `/reload`, `/name`, and `/settings` → Theme, respectively. Effort levels and cost/billing are not exact equivalents. |
| Use Pi integrations, not Claude's | `/feedback`, `/mcp`, `/plugin`, `/statusline` | `/bug` reports Pi issues; Pi's `mcp` CLI and package manager cover setup; Bi already has a footer. Do not forward reports, install packages, start servers, or execute statusline scripts from a compatibility shortcut. |
| Implement first | `/context`, `/help`, `/plan`, `/skills`, `/status` | Standalone Bi commands backed by existing state or Pi APIs; no new provider dependencies. |
| Implement second | `/security-review` | Defensive, read-only review of an explicitly selected local diff; no remote review. |
| Later, only with a separate design and demand | `/add-dir`, `/agents`, `/color`, `/files`, `/hooks`, `/insights`, `/memory`, `/pr-comments`, `/sandbox`, `/stats`, `/tag`, `/terminal-setup`, `/vim` | Examples: `/memory` as a read-only project-instruction view first; `/files` as context metadata, not a disk scan; `/tag` via Pi session labels if the semantics fit. `/add-dir` needs real workspace-scope enforcement; `/sandbox` cannot just rename Bi's mode gate. Review remote PR commands, executable hooks, transcript reports, and editor ownership separately. |
| Skip Claude-specific, hidden, or experimental features | `/advisor`, `/brief`, `/chrome`, `/desktop`, `/extra-usage`, `/fast`, `/heapdump`, `/ide`, `/install-github-app`, `/install-slack-app`, `/mobile`, `/output-style`, `/passes`, `/privacy-settings`, `/rate-limit-options`, `/remote-control`, `/remote-env`, `/stickers`, `/think-back`, `/thinkback-play`, `/ultrareview`, `/upgrade`, `/usage`, `/voice`, `/web-setup` | No fake handlers. `/usage` is account/quota data, not Bi token accounting; `/output-style` is hidden/deprecated in the snapshot. Revisit provider-neutral equivalents only if there is a user need. |

### Bundled skills and internal entries

- **Keep:** `/simplify` already exists in Bi. **Adapt next:** `/verify`, an internal-only bundled skill in this snapshot, is useful as a provider-neutral Bi workflow.
- **Document an alternative or defer:** `/debug` and `/stuck` → `/doctor` or `/tasks` for local diagnostics; `/update-config` → `/settings` or explicit reviewed changes; `/remember` and `/skillify` → user-reviewed instructions/templates, no automatic writes. `keybindings-help` is model-only; `/lorem-ipsum` isn't needed for Bi.
- **Not in scope:** `/batch`, `/loop`, `/schedule`, `/claude-api`, `/claude-in-chrome`. These need separate orchestration, provider, or integration design. `/goal` covers bounded continuation, not scheduled jobs. Conditional bundled modules `dream`, `hunter`, and `runSkillGenerator` are referenced but absent in this mirror.
- **Concrete internal names:** `/commit`, `/commit-push-pr`, `/init-verifiers`, `/bridge-kick`, `/version`, `/ultraplan`. Not public parity targets. The registry also references absent conditional command modules and disabled `stub` entries; don't infer support from them. The `/install` definition is outside this slash registry; `install` exists as a CLI subcommand.
- **Snapshot aliases:** `/clear` → `/reset`, `/new`; `/config` → `/settings`; `/exit` → `/quit`; `/feedback` → `/bug`; `/resume` → `/continue`; `/rewind` → `/checkpoint`; `/permissions` → `/allowed-tools`; `/tasks` → `/bashes`; `/branch` → `/fork` when its feature gate allows; `/mobile` → `/ios`, `/android`; `/desktop` → `/app`; `/session` → `/remote`; `/plugin` → `/plugins`, `/marketplace`; `/remote-control` → `/rc`. These aren't extra canonical commands. Don't shadow Pi's `/new`, `/settings`, `/quit`, `/bug`, or `/fork`.

### Existing Bi commands: name match doesn't mean behavior match

Bi registers **10** commands: the eight in the main-registry overlap plus `/simplify` and Bi-only `/goal`. See `src/index.ts`, `src/tui/permission-rules.ts`, and `src/extension/register-tools.ts`; the [extension roadmap](../bi-extension-roadmap.md) is not the runtime inventory.

| Command | Difference worth documenting |
| --- | --- |
| `/init`, `/doctor` | Claude writes `CLAUDE.md` and diagnoses its own installation. Bi writes `AGENTS.md` via the agent and diagnoses effective Bi settings, tools, and Git. |
| `/review`, `/diff` | Claude `/review` is a GitHub PR workflow; Bi reviews the local working tree. Bi `/diff` browses staged or unstaged tracked changes, not per-turn diffs. Keep local as the default; any PR workflow must be explicitly requested. |
| `/simplify` | Claude's bundled skill uses parallel review agents; Bi uses the current agent. Reuse, clarity, and efficiency can be separate passes without adding agents. |
| `/permissions`, `/rewind` | Bi shows rules read-only. Bi `/rewind` restores only the latest eligible Bi file operation, not the conversation or Git state. Keep the preview and destructive confirmation. |
| `/btw`, `/tasks` | Claude `/btw` is immediate and can use conversation context; Bi is idle-only and sends just the approved question. Claude `/tasks` manages background work; Bi shows branch-scoped goal/todos and reported verification. |

## Implementation sequence

### 1. Local commands and discovery

Register through `src/commands/index.ts` and `src/index.ts`; use `ctx.ui.custom()` and `src/tui/text.ts` for bounded literal output. Use public APIs available in the locked Pi 1.5.2 and checked against installed Pi 1.6.0. Keep a small migration table, not a second Pi dispatcher. `pi.getCommands()` gives extension/template/skill commands but not TUI built-ins; document or list native equivalents separately and don't present them as RPC-supported.

| Command | First-release behavior and wiring |
| --- | --- |
| `/help [command]` | Group discovered commands by source and show Bi/Pi/Claude-name equivalents and limits. Use Pi's actual invocation names, including suffixes on collisions; distinguish “built in”, “partial”, “planned”, and “not supported”. |
| `/skills` | List loaded skill names/descriptions and available `/skill:<name>` invocations from Pi metadata. Distinguish advertised skills from those exposed as commands. Do not read skill bodies or execute anything. |
| `/context` | Show estimated used/free tokens and window size via `ctx.getContextUsage()`, plus counts of tools/context files/skills when available. Handle no model or unknown usage. Use `ctx.getSystemPromptOptions()` metadata only; don't print prompt, transcript, config, or file bodies. |
| `/status` | One short local summary: current model, trust, permission mode, active tool count, and goal status (not the objective text). Reuse existing state/read helpers; link to `/doctor`, `/permissions`, and `/session` instead of duplicating their panels. No provider quota requests. |
| `/plan [request]` and `/plan show` | Bare `/plan` enters Plan from Manual, Edits, or Auto; if already in Plan, it shows the current session's saved note or an empty state. `show` only views the note. Add a narrow entry method to `src/extension/permission-modes/index.ts` and reuse `plan-note.ts`. Only a non-empty request starts a model turn, after the restricted tool set is active. Idle TUI only and no implicit switch out of No prompts or Bypass. No external editor, arbitrary path, or implementation approval in this handler. |

Ship the four read-only views together, then `/plan` separately. Bare `/plan` and `/plan show` never query a model; the existing plan approval flow still owns the decision to implement.

### 2. Prompt workflows

- **`/verify [focus]`:** write a Bi prompt that finds supported checks, inspects them before execution, runs only what existing policy permits, and reports passed/failed/not-run with evidence. In Plan, propose checks only. No implicit fixes, installs, networking, or elevated permissions. Keep the existing `/goal` and `goal_report` contract.
- **`/security-review [staged|unstaged]`:** reuse the authorized, bounded local diff path from `src/commands/diff.ts` and `src/tools/git.ts`. Preview the scope and disclose/confirm what goes to the selected provider. Use a tool-free request pattern like `src/commands/btw.ts` for the approved diff, and report findings, line references where available, fixes, and scope limits. No file changes, exploit generation, active probing, GitHub calls, or automatic fixes. A prompt saying “read-only” is not an authorization boundary.
- Keep `/review [focus]` backward compatible. Consider a later **explicit** `/review --pr <number>` or `/pr-comments <number>` only with a separately approved network policy. Never treat free-text focus as a shell command or URL.

### 3. Compatibility names and migration

- Add `/checkpoint` and `/allowed-tools` as aliases of the existing guarded Bi handlers, with their Bi limits visible. If exact `/rename <title>` and `/clear` are needed, use `pi.setSessionName()` and `ctx.newSession()` after idle checks (with confirmation before switching sessions). `/clear` must not delete previous history. Prefer documenting native equivalents such as `/settings` and `/quit` rather than sending them through `sendUserMessage()`.
- For **user-owned** `.claude/commands/*.md` and `.claude/skills/`, document manual migration to `.pi/prompts/*.md` and `.agents/skills/` respectively. Review and adapt arguments and tool names. No automatic import, prompt-time shell expansion, hooks, or `allowed-tools` grants. Keep Bi's core and trust policy unchanged.

## Release checks

- One PR per tranche. For read-only commands assert **zero** model requests, shell calls, project writes, and transcript changes. Check missing model/usage, empty state, conflicting command names, hostile terminal text, and unsupported modes. Allow bounded RPC summaries where supported; TUI-only actions must not inject text into JSON/print output.
- For `/plan`, test idle/queued input, every starting permission mode, no note, stale session, `/tree`, `/reload`, and that the handler never approves implementation. Verify tool restriction and mode persistence happen before a planning turn starts. Direct command I/O does not pass through Pi's model `tool_call` hook: reuse Bi's checks, reject invalid rules and stale approvals, and keep unsupported paths fail-closed.
- For prompt workflows use mocked model/tool calls to verify no action on cancellation, denial, or unsupported mode; no secret-bearing dumps or context leaks; no silent permissions changes; and no unverifiable test claims. For diff review, test protected paths, size caps, consent to transmit, and no execution of unexpected tool-call blocks.
- Run `npm run typecheck` and `npm test`, then smoke-test in a disposable project with `pi -e ./` (narrow TUI, Esc, RPC support/denial, reload, and Plan/No prompts). Update `README.md` with exact names, Pi equivalents, compatibility limits, and data sent or retained. Keep `/temp/` ignored and out of the package.
