# bi

A [Pi coding agent](https://pi.dev) extension package.

## Structure

```
bi/
├── AGENTS.md                     # Coding-agent guidance
├── package.json                  # Pi extension manifest and npm scripts
├── package-lock.json             # Locked npm dependency versions
├── .prettierrc                   # Formatting preferences
├── tsconfig.json                 # TypeScript compiler configuration
├── README.md                     # Usage and development documentation
├── src/
│   ├── index.ts                  # Pi extension entry point
│   ├── config/                   # Low-code defaults for tools, UI, timeout, and prompt
│   ├── extension/                # Pi tool registration, prompts, and startup settings
│   │   ├── ask-user.ts           # Structured UI question helper
│   │   ├── index.ts              # Extension module exports
│   │   ├── quiet-startup.ts      # Project-local quiet-startup setting
│   │   ├── register-tools.ts     # Bridges tool system into Pi's API
│   │   └── system-instruction.ts # System prompt assembly
│   ├── commands/                 # Slash commands
│   │   ├── index.ts              # Slash module exports
│   │   └── init.ts               # /init command
│   ├── tools/                    # Tool implementations, registry, and dispatch
│   │   ├── advanced.ts           # Advanced tools
│   │   ├── agent.ts              # Agent interaction tools
│   │   ├── dispatcher.ts         # Validates and executes tool calls
│   │   ├── execution.ts          # Shell/process execution tools
│   │   ├── filesystem.ts         # Filesystem tools
│   │   ├── git.ts                # Git tools
│   │   ├── index.ts              # Assembles and exports the tool system
│   │   └── registry.ts           # Tool registration and lookup
│   ├── tui/index.ts              # Branded TUI header and status footer
│   └── types/                    # Shared tool and domain types
│       ├── agent.ts
│       ├── common.ts
│       ├── execution.ts
│       ├── index.ts
│       └── tools.ts
└── tests/                        # Node.js test-runner suites
    ├── extension.test.ts         # Extension helper tests
    └── tools.test.ts             # Tool registry, dispatcher, and tool tests
```

Keep TypeScript source and test files below 1000 lines. Split files by responsibility
before they approach that limit.

## Usage

```bash
# Try for one session (no install needed)
pi -e ./

# Install as a local package
pi install ./

# Or copy into the global extensions directory
mkdir -p ~/.pi/agent/extensions/bi
cp -r . ~/.pi/agent/extensions/bi
```

Inside pi:

- `/init` — analyzes the codebase and generates/updates `AGENTS.md` at the project root
- `/goal <objective>` — starts a persistent goal with a bounded automatic continuation loop
- `/goal` or `/goal status` — show the saved goal and its progress
- `/goal pause`, `/goal resume`, `/goal clear` — manage the current goal
- `/goal edit <objective>`, `/goal budget <1-50>` — update the objective or iteration limit
- `/diff [staged|unstaged]` — browse tracked Git changes without a model call
- `/doctor` — diagnose Bi preferences, permission rules, inactive tools, and Git availability
- `/tasks` — view the current branch's goal and todos
- `/btw [question]` — ask a standalone question without adding it to the main transcript
- `/rewind` — preview and restore the latest tracked Bi file operation
- `/review` — reviews the current changes
- `/simplify` — looks for opportunities to simplify code
- Interactive mode uses a responsive welcome panel, prompt chevron, compact permission footer, and collapsible tool output. Use **Ctrl+O** (Pi's default) to expand tool output and `/session` to see usage statistics.
- Select a bundled theme in `/settings` → **Theme**: `bi`, `catppuccin-mocha`,
  `github-dark`, `tokyo-day`, `tokyo-night`, `vercel-black`, or `vercel-light`.
  To try the warm `bi` theme without installing: `pi -e ./ --theme ./themes/bi.json --use-theme bi`.

Goal state is stored in the current Pi session transcript, so it survives session
resume and follows session branches. Active goals continue through Pi's
`agent_before_settle` lifecycle hook, up to 8 automatic iterations by default
(configurable with `/goal budget`). `/goal resume` grants another bounded run
after budget exhaustion. Pressing Escape pauses the goal; use `/goal resume` to
continue. Each turn must send exactly one `goal_report`; missing or duplicate
reports stop the loop. When blocked, the agent should ask one focused question
rather than guess. bi relies on the agent's report and verification evidence for
completion/blocker decisions; this is not an independent verifier, and it does
not guarantee a goal will finish within the iteration budget.

### Reviewing and managing a session

| Command | Behavior and limits |
| --- | --- |
| `/diff` | TUI only. Tab switches staged/unstaged; use arrows and Enter to load one file's patch on demand. `n`/`p` opens the next/previous patch; Esc goes back or closes the picker. Untracked files and submodule changes are omitted. The viewer honors `git_diff` rules, asks before showing sensitive paths, and does not modify the worktree or index. |
| `/doctor` | Read-only diagnostics in TUI or RPC. Shows effective settings and why supported preferences were ignored, without printing raw config or credential values. TUI also shows whether Bi's editor is active and how that affects its shortcuts. Use `/permissions` for rule details and `/hotkeys` for all bindings. |
| `/tasks` | Read-only dashboard in TUI or RPC. Goal state and todos follow the active transcript branch. Verification is the agent's latest report, not an independent check. Use `/goal` to manage the goal. |
| `/btw` | Idle TUI only, outside Plan and No prompts. After confirmation, the active provider receives the question, but no main transcript, project files, or tools. Esc cancels. Usage is shown separately in the overlay. Provider retention policies still apply. Inline questions can appear in Pi's input history; use bare `/btw` for a separate input field. |
| `/rewind` | Idle TUI only, outside Plan and No prompts. Previews the affected paths and always asks for confirmation. Supports tracked `edit`, `write`, and `apply_patch`; a newly created file can be removed, but parent directories are left in place. Refuses changed files. Multi-file rollback is best-effort and reports incomplete restores. History is bounded and in memory; it does not survive branch changes, reload, or session switch. Shell commands, Git state, and conversation history are not rewound. |

### Tool execution safety

Shell, background, terminal, and code-execution tools require either an
`allowCommand` policy supplied to `createExecutionTools()` or per-command
approval through the tool context. Destructive filesystem and Git operations
also require a UI approval callback; both kinds of operation are denied when
the extension has no UI or configured policy.

### Low-code configuration

Edit [`src/config/bi.config.json`](src/config/bi.config.json) for common defaults;
all tool groups are enabled by default:

| Setting | What it changes |
| --- | --- |
| `toolGroups.filesystem` / `execution` / `git` / `agent` / `advanced` | Registers or disables the corresponding tool group |
| `filesystem.defaultReadLimit` | Default number of lines returned by `read` |
| `filesystem.maxReadLineLength` | Maximum displayed characters per line before truncation |
| `filesystem.maxGrepMatches` | Maximum matches returned by `grep` |
| `git.defaultLogLimit` | Default number of commits shown by `git_log` (1–100) |
| `execution.timeoutMs` | Timeout for foreground shell and JavaScript execution, in milliseconds |
| `output.maxChars` | Maximum output returned/captured for a tool call |
| `startup.autoEnableQuietStartup` | Adds `quietStartup: true` only when the project's Pi setting is unset; false disables this automatic change |
| `systemPrompt.additional` | Extra project instructions, up to 8,000 characters; applied only when Pi trusts the project |
| `ui.startupMessage` | Session-start notification text outside the TUI |
| `ui.workingTips` | Enable TUI tips while waiting for a reply and set their delay (default: 20 seconds) |
| `ui.tagline`, `gettingStartedTitle`, `gettingStarted` | Welcome/header copy |
| `ui.commands`, `ui.keys`, `commandsTitle`, `keysTitle` | Header commands, key hints, and their headings |
| `systemPrompt.core` | bi's identity and workflow instructions (each array item is one prompt line) |

On the first session start outside Plan mode, bi creates `.pi/config.json` with the current safe
package defaults if it does not exist. Existing files are never overwritten.
Projects may edit and commit this file; other `.pi` runtime data remains ignored:

```json
{
  "filesystem": { "defaultReadLimit": 500, "maxReadLineLength": 1500, "maxGrepMatches": 200 },
  "git": { "defaultLogLimit": 20 },
  "output": { "maxChars": 50000 },
  "startup": { "autoEnableQuietStartup": false },
  "systemPrompt": { "additional": "Follow this project's coding conventions and test commands." }
}
```

Package defaults are used for missing, invalid, or out-of-range values. Project
config is size-limited and allowlisted; tool preferences are reread on each call
(startup settings at session start). Project instructions add to—not replace—the
package core prompt, and are ignored until Pi trusts the project. Config cannot
change tool groups, command authorization, execution timeouts, or destructive-operation approvals.
Output is capped at 1,000,000 characters, grep at 10,000 matches, and Git history
at 100 commits even if a package default is changed.

`createToolSystem({ config })` also accepts a `BiConfig` override for callers
and tests. Timeout must be a positive integer. Tool implementations, argument
validation, command authorization, and destructive-operation approvals remain
in TypeScript. Use TypeScript to change how a tool works or add a new tool.

### How `/init` works

1. Checks `AGENTS.md` doesn't already exist (asks before overwriting)
2. Sends a user prompt to the agent instructing it to explore the project
   (docs, manifests, directory structure) and write a concise `AGENTS.md`
   with overview, build/test/lint commands, architecture notes, and code style
3. The agent runs with its normal tools (read, edit, write) to produce the file

## Permission modes

Press **Shift+Tab** in bi's prompt (or **Alt+M**) to cycle Manual → Edits → Plan → Auto → Manual. The mode appears below the prompt. With the default Pi keybinding, **Alt+T** cycles thinking in bi's editor instead. If another extension already supplies an editor, bi leaves it alone and only registers Alt+M. Modes follow the session branch and take effect for the next tool call. `/reload` preserves the selected mode but clears temporary approvals. Plan startup does not change bi's project config or quiet-startup setting.

Permission dialogs show what is being requested, including proposed file changes or the shell command. Use the numbered choices, or arrows and Enter; Esc cancels. PageUp/PageDown scroll long previews. A saved plan is shown before implementation can start. `/permissions` shows effective Allow, Ask, and Deny rules with their sources, the number of session approvals, and recent mode-gate denials. It does not add or modify rules.

| Mode | Behavior |
| --- | --- |
| Manual (`default`) | Ordinary reads pass the mode gate; edits and uncertain calls require approval. |
| Edits (`acceptEdits`) | Also permits ordinary project edits after path checks. Outside and sensitive paths require approval. |
| Plan (`plan`) | Restricts the active tools to investigation and session bookkeeping. `plan_note` writes only `.pi/plans/<session-id>.md`; after a change, choose whether to start in Edits or Manual, keep planning, or discard the note. |
| Auto (`auto`) | Uses the Edits rules. With no configured reviewer it falls back to asking; the injectable reviewer receives only a safe summary and times out after 15 seconds. |
| No prompts (`dontAsk`) | Declines calls whenever either the mode gate or a bi tool requires confirmation. Launch only with `--permission-mode dontAsk`. |
| Bypass (`bypassPermissions`) | Skips routine mode prompts for eligible calls, after interactive confirmation at launch with `--permission-mode bypassPermissions`. |

The last two modes are not in the shortcut cycle. Bypass cannot be restored from a transcript without the launch flag and confirmation. An approval can be granted once or, for eligible file calls, for those exact arguments and resolved paths during the session. Sensitive or outside paths require fresh confirmation. Explicit ask and deny rules always take precedence.

Optional trusted user settings live in `~/.pi/agent/permission-modes.json`. For example:

```json
{ "defaultMode": "acceptEdits", "ask": ["write:docs/*"], "deny": ["read:.env*"] }
```

Rules use `tool:pattern`, where `*` and `?` are glob characters. User settings may also contain `allow`; project `.pi/permission-modes.json` can contain only `ask` and `deny`. Invalid configuration blocks tool calls until corrected. These files are separate from `.pi/config.json`.

Path-based allow rules match the resolved destination against the configured pattern. A rule such as `write:docs/*` stays scoped to `docs/` if that directory becomes a symlink. For calls without a path or shell input, rule patterns match the JSON-encoded arguments, so `git_diff:*` covers every diff call. Permission rules files are protected from tool writes and must be regular files with one link. The loader rejects symlinks in the path below the project root or home directory.

Read-only Git tools and the footer's Git status check disable optional index writes and repository-configured helpers such as filesystem monitoring and worktree filters. Worktree status and diff may therefore differ from a normal Git invocation, including for submodules. In-place file writes refuse hard-linked files.

The mode gate is a tool-call filter, not an operating-system sandbox. It blocks protected paths and recognized critical operations, but cannot inspect all effects of an approved command, script, external tool, or a process already running. bi's own command and destructive-operation confirmations still apply after the mode gate, including in Bypass. Auto ships without a network reviewer and asks when its static policy cannot decide.

## System prompt

bi uses its own system prompt — pi's default system instruction is fully
replaced via a `before_agent_start` handler that returns the complete prompt
for every run.

- Edit `systemPrompt.core` in `src/config/bi.config.json` to change bi's identity and workflow rules
- The builder in `src/extension/system-instruction.ts` re-embeds what pi's default prompt would have provided: tool
  guidance (`toolSnippets`/`toolGuidelines`), context files (`AGENTS.md`
  content), skills, custom sections, and `--append-system-prompt`
- User-supplied `--system-prompt` / `SYSTEM.md` prefixes are kept in front

## Development

```bash
npm install        # install dev deps (types, tooling)
npm run typecheck  # type-check the extension
npm test           # run all tests (Node.js with TypeScript transform support)
node --experimental-transform-types --test tests/tools.test.ts # run one test file
```

Host-provided packages (`@earendil-works/pi-coding-agent`, `typebox`, etc.)
are declared as optional `peerDependencies` — pi supplies them at runtime.
