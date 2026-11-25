# Honeycomb

A [Pi coding agent](https://pi.dev) extension package.

## Structure

```
honeycomb/
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

With `pi` already on your `PATH`, install Honeycomb from this checkout and launch it with `bee`:

```bash
npm install -g .
bee
bee --help
```

`bee` starts Pi with Honeycomb loaded and forwards Pi session arguments. The existing
`--bi-*` flags keep their names for compatibility. You can also use Pi directly:

```bash
# Try for one session (no install needed)
pi -e ./

# Install as a local package
pi install ./

# Or copy into the global extensions directory
mkdir -p ~/.pi/agent/extensions/honeycomb
cp -r . ~/.pi/agent/extensions/honeycomb
```

Inside pi:

- `/init` — analyzes the codebase and generates/updates `AGENTS.md` at the project root
- `/goal <objective>` — starts a persistent goal with a bounded automatic continuation loop
- `/goal` or `/goal status` — show the saved goal and its progress
- `/goal pause`, `/goal resume`, `/goal clear` — manage the current goal
- `/goal edit <objective>`, `/goal budget <1-50>` — update the objective or iteration limit
- `/diff [staged|unstaged]` — browse tracked Git changes without a model call
- `/doctor` — diagnose Honeycomb preferences, permission rules, inactive tools, and Git availability
- `/tasks` — view the current branch's goal and todos
- `/allowed-tools` — read-only alias for `/permissions`; `/checkpoint` — alias for `/rewind` (latest eligible Honeycomb file operation only)
- `/verify [focus]` — ask the current agent to inspect and run permitted checks; in Plan mode, propose checks only
- `/plan [request]` — enter Plan mode or start a planning turn; `/plan show` displays the session note subject to read rules
- `/security-review staged|unstaged` — explicitly approve a bounded local diff for a separate tool-free model review
- `/help`, `/skills`, `/context`, `/status` — local command discovery and session metadata
- `/tool-search [name]` — search registered tool names and see which are active without calling them
- `/lsp` — open the optional language server setup menu
- `/worktree [list|create <directory-name>|leave]` — list Git checkouts, create a detached checkout, or find your way back to the main checkout
- `/btw [question]` — ask a standalone question without adding it to the main transcript
- `/rewind` — preview and restore the latest tracked Honeycomb file operation
- `/review` — reviews the current changes
- `/simplify` — looks for opportunities to simplify code
- Interactive mode uses a responsive welcome panel, prompt chevron, status footer, and collapsible tool output. The detailed footer shows session usage across all recorded entries (including other branches), estimated cost, and elapsed wall time including time away. Set `ui.footerStyle` to `"compact"` in `.pi/config.json` to use the original compact footer; the default is `"detailed"`. Use **Ctrl+O** (Pi's default) to expand tool output and `/session` to see usage statistics.
- Select a bundled theme in `/settings` → **Theme**: `honeycomb-light`, `honeycomb-dark`,
  `catppuccin-mocha`, `github-dark`, `tokyo-day`, `tokyo-night`, `vercel-black`, or `vercel-light`.
  To try the Honeycomb pair and match your terminal's appearance: `pi -e ./ --theme ./themes/honeycomb-light.json --theme ./themes/honeycomb-dark.json --use-theme honeycomb-light/honeycomb-dark`.
  If you previously selected `honeycomb`, switch to `honeycomb-dark` to keep the original palette.

Goal state is stored in the current Pi session transcript, so it survives session
resume and follows session branches. Active goals continue through Pi's
`agent_before_settle` lifecycle hook, up to 8 automatic iterations by default
(configurable with `/goal budget`). `/goal resume` grants another bounded run
after budget exhaustion. Pressing Escape pauses the goal; use `/goal resume` to
continue. Each turn must send exactly one `goal_report`; missing or duplicate
reports stop the loop. When blocked, the agent should ask one focused question
rather than guess. Honeycomb relies on the agent's report and verification evidence for
completion/blocker decisions; this is not an independent verifier, and it does
not guarantee a goal will finish within the iteration budget.

### Reviewing and managing a session

| Command | Behavior and limits |
| --- | --- |
| `/diff` | TUI only. Tab switches staged/unstaged; use arrows and Enter to load one file's patch on demand. `n`/`p` opens the next/previous patch; Esc goes back or closes the picker. Untracked files and submodule changes are omitted. The viewer honors `git_diff` rules, asks before showing sensitive paths, and does not modify the worktree or index. |
| `/doctor` | Read-only diagnostics in TUI or RPC. Shows effective settings and why supported preferences were ignored, without printing raw config or credential values. TUI also shows whether Honeycomb's editor is active and how that affects its shortcuts. Use `/permissions` for rule details and `/hotkeys` for all bindings. |
| `/tasks` | Read-only dashboard in TUI or RPC. Goal state and todos follow the active transcript branch. Verification is the agent's latest report, not an independent check. Use `/goal` to manage the goal. |
| `/help [command]` | Lists discovered extension, prompt and skill commands. Pi TUI built-ins are not included in discovery; `/clear` corresponds to `/new`, `/config` to `/settings`, and `/exit` to `/quit`. |
| `/skills` | Lists loaded skill metadata and separately lists exposed skill commands; does not read skill bodies. |
| `/context` | Shows estimated token usage and metadata counts, not prompt or file contents. Usage can be unknown. |
| `/status` | Shows local model, trust, permission mode, active tool count and goal status. No provider quota request is made. |
| `/verify [focus]` | Starts a model turn with the focus text and current conversation. The agent inspects checks and uses existing tool permissions; in Plan mode it is instructed to propose checks only. |
| `/plan [request]` | Idle TUI only. Enters Plan without starting a turn unless a request is supplied; `/plan show` displays the session note if read rules allow it. It does not leave No prompts or Bypass, or approve implementation. |
| `/security-review staged\|unstaged` | Idle TUI only, outside Plan and No prompts. Sends the selected tracked local diff (maximum 12 KB) to the selected provider only after confirmation; protected diffs are refused. No conversation or tools are sent. Provider retention policies apply. |

These four views do not start a model turn or send their output to the provider. RPC receives bounded notifications; print and JSON modes do not display the panels.

For user-owned Claude commands and skills, migrate manually: review `.claude/commands/*.md` and adapt them to `.pi/prompts/*.md`, and review `.claude/skills/` for migration to `.agents/skills/`. Adapt arguments and tool names to Pi and Honeycomb. Honeycomb does not automatically import these files, expand shell commands, run hooks, or grant their `allowed-tools` permissions.
| `/btw` | Idle TUI only, outside Plan and No prompts. After confirmation, the active provider receives the question, but no main transcript, project files, or tools. Esc cancels. Usage is shown separately in the overlay. Provider retention policies still apply. Inline questions can appear in Pi's input history; use bare `/btw` for a separate input field. |
| `/rewind` | Idle TUI only, outside Plan and No prompts. Previews the affected paths and always asks for confirmation. Supports tracked `edit`, `write`, `apply_patch`, and `notebook_edit`; a newly created file can be removed, but parent directories are left in place. Refuses changed files. Multi-file rollback is best-effort and reports incomplete restores. History is bounded and in memory; it does not survive branch changes, reload, or session switch. Shell commands, Git state, and conversation history are not rewound. |

### Tool discovery and file matching

`/tool-search [name]` shows tool names and active/inactive status for the current
session in TUI or RPC. Active means exposed to the model, not authorized to run.
This is not a usage log. See the [tool parity matrix](plan/tools/tool-parity.md).

`glob` lists files matching a relative pattern such as `src/**/*.ts`, with an
optional workspace subdirectory as its search root. Patterns support `*`, `?`,
and `**` as a path component. Unlike `find` (name substring) and `grep` (literal
contents), it matches relative paths without reading file contents. It skips
symlinks, protected paths, and `.pi`/`.bi` state directories, and bounds both the
scan and the results. It does not parse project `.gitignore` files.

`notebook_edit` edits the source of one existing cell in a local nbformat 4
`.ipynb` file (up to 1 MiB). Read the notebook first, then provide `path`,
zero-based `cell_index`, exact `old_source`, and `new_source`. For array sources,
join the strings without adding separators. Honeycomb previews the change and requires
one-time approval; cells are never executed, and bytes outside the selected
source value are preserved. Both the filesystem and agent groups must be enabled
so the edit can be tracked by `/rewind`. This tool is unavailable in Plan mode.

### Optional local language-server queries

In an idle, trusted Pi terminal, open `/lsp`. Use the arrow keys and Enter to
choose **TypeScript / JavaScript** or **Use an existing server**, or Esc to exit.
On macOS/Linux with npm on `PATH`, Honeycomb can download the displayed versions from
npm and install them under `~/.bi-lsp/` only after confirmation. npm lifecycle
scripts are disabled, and project and global npm packages are not changed. The
existing-server option takes an absolute executable path outside the workspace
and requires `--stdio` support. Managed setup needs a data folder outside the workspace.

Enabling a server for the current session is a separate confirmation. You can
also opt in at launch with `--bi-lsp-server /absolute/path/to/server`. If no
managed, configured or `PATH` TypeScript server is found, rotating working tips
point to `/lsp`. The tool starts one process per approved query and is blocked
in Plan and No prompts modes.
For example, send `{"action":"definition","path":"src/index.ts","language_id":"typescript","line":0,"character":0}`.
Positions are zero-based UTF-16. `references` and `hover` also take a position;
`diagnostics` omits it and needs a server that supports pull or publishes on open.

Only use a server you trust: it receives the source file and workspace path,
and can read other files or run code under your user account. This is not a
sandbox. Honeycomb does not honor server requests for client actions (such as applying
edits); returned locations are limited to permitted workspace files. Each request
has an eight-second deadline, so cold or large projects may time out.

### Git worktrees

From the root of a trusted Git checkout in an idle Pi terminal:

- `/worktree` or `/worktree list` lists linked checkouts and marks the current one.
- `/worktree create <directory-name>` previews a new subdirectory and the exact
  commit to check out in detached HEAD state. Creation needs explicit confirmation
  and a clean checkout. Ordinary untracked files still block creation; registered
  nested worktrees are separate checkouts and don't count as parent changes, even
  if `git status` lists them as untracked. Changes inside submodules are ignored.
  Checkout hooks and external Git filters are disabled for this command.
- `/worktree leave` identifies the main checkout and warns about local changes
  in the current linked checkout. It leaves the checkout and all files intact.

Open a new Pi session to use a different checkout. These commands never switch
Pi's working directory, remove worktrees, or create branches.

### Optional public web fetch

Launch Pi with `pi -e ./ --bi-web-fetch` in a trusted workspace. Ask the model,
for example, “Read `https://example.org/` and summarize it.” The model proposes
URLs via `web_fetch`; Honeycomb previews the full destination and asks for approval on
**each** request. Plan, No prompts, and noninteractive sessions cannot fetch.

The tool issues an HTTPS GET to a public IPv4 address on the default port. It
uses no cookies, credentials, or proxy and does not execute page scripts. The
site sees the requested URL (including query parameters) and your network address.
Never put secrets in URLs. Redirects are not followed: the model must request
any new destination separately. Only uncompressed text, HTML, Markdown, and JSON
are supported, with a 10-second deadline, a 128 KiB response cap, and truncated
model output. Returned text is untrusted. This feature does not search the web.

### Optional Tavily web search

Set `TAVILY_API_KEY` in the shell that launches Pi, then run
`pi -e ./ --bi-web-search` in a trusted workspace. Do not put the key in
`settings.json`, project files, or chat. If the key is missing, Honeycomb leaves
`web_search` inactive and shows a startup warning and a working tip.

Ask the model to search for a topic. Honeycomb previews the exact query and requires
one-time approval before sending it to Tavily. Tavily receives the query and
returns up to five results to Honeycomb; the model sees those results, not the API
key. Avoid sending secrets in queries. Plan, No prompts, and noninteractive
sessions cannot search. `web_fetch` remains separate and does not need a key.

### Optional Pi MCP resource access

Configure an MCP server you trust in Pi and check its name and source in `/mcp`.
Then launch `pi -e ./ --bi-mcp-resource-server docs`, replacing `docs` with the
exact configured server name. The flag does not configure or connect a server;
Pi still owns connections, authentication and tool exposure.

If Pi exposes `list_mcp_resources`, `list_mcp_resource_templates`, or
`read_mcp_resource`, Honeycomb requires the selected server explicitly and asks for
one-time approval for each call. Resource reads show the URI before approval.
Honeycomb blocks these calls without the flag, in untrusted projects, in Plan or No
prompts mode, and without an interactive UI. Existing deny rules can match the
server name or URI, for example `read_mcp_resource:docs`.

This gate applies only to those three resource tools, not other MCP capabilities.
Pi controls output handling: listed metadata and returned text or images can
reach the model, and binary data can be saved to temporary files. This is not a
text-only mode. Check which server a project config selects before approving.

### Tool execution safety

Shell, background, terminal, and code-execution tools require either an
`allowCommand` policy supplied to `createExecutionTools()` or per-command
approval through the tool context. Destructive filesystem and Git operations
also require a UI approval callback; both kinds of operation are denied when
the extension has no UI or configured policy.

Managed process IDs and output belong to the Pi session that started them.
Session replacement, branch changes, and shutdown (including reload) retire
those IDs and cancel in-flight execution. Honeycomb closes its process pipes and
terminates still-running managed process groups on POSIX. This is not a sandbox:
commands that leave their process group or outlive its exited leader are not
covered by cleanup.

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
| `systemPrompt.core` | Honeycomb's identity and workflow instructions (each array item is one prompt line) |

On the first session start outside Plan mode, Honeycomb creates `.pi/config.json` with the current safe
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
| Edits (`acceptEdits`) | Also permits ordinary project edits after path checks. Sensitive operations still require approval when eligible. |
| Plan (`plan`) | Restricts the active tools to investigation and session bookkeeping. `plan_note` writes only `.pi/plans/<session-id>.md`; after a change, choose whether to start in Edits or Manual, keep planning, or discard the note. |
| Auto (`auto`) | Uses the Edits rules. With no configured reviewer it falls back to asking; the injectable reviewer receives only a safe summary and times out after 15 seconds. |
| No prompts (`dontAsk`) | Declines calls whenever either the mode gate or a Honeycomb tool requires confirmation. Launch only with `--permission-mode dontAsk`. |
| Bypass (`bypassPermissions`) | Skips routine mode prompts for eligible calls, after interactive confirmation at launch with `--permission-mode bypassPermissions`. |

The last two modes are not in the shortcut cycle. Bypass cannot be restored from a transcript without the launch flag and confirmation. An approval can be granted once or, for eligible file calls, for those exact arguments and resolved paths during the session. Honeycomb rejects hard policy blocks before its own approval dialog: workspace file tools cannot open paths outside the workspace, including through symlinks, and protected shell redirects (including `2>/dev/null`) stay blocked. An approval from Pi or another layer cannot override these restrictions. Eligible sensitive or outside-path calls still require fresh confirmation. Deny rules take precedence over Ask and Allow; none can override a hard boundary.

Optional trusted user settings live in `~/.pi/agent/permission-modes.json`. For example:

```json
{ "defaultMode": "acceptEdits", "ask": ["write:docs/*"], "deny": ["read:.env*"] }
```

Rules use `tool:pattern`, where `*` and `?` are glob characters. User settings may also contain `allow`; project `.pi/permission-modes.json` can contain only `ask` and `deny`. Invalid configuration blocks tool calls until corrected. These files are separate from `.pi/config.json`.

Path-based allow rules match the resolved destination against the configured pattern. A rule such as `write:docs/*` stays scoped to `docs/` if that directory becomes a symlink. For calls without a path or shell input, rule patterns match the JSON-encoded arguments, so `git_diff:*` covers every diff call. Permission rules files are protected from tool writes and must be regular files with one link. The loader rejects symlinks in the path below the project root or home directory.

Read-only Git tools and the footer's Git status check disable optional index writes and repository-configured helpers such as filesystem monitoring and worktree filters. Worktree status and diff may therefore differ from a normal Git invocation, including for submodules. In-place file writes refuse hard-linked files.

The mode gate is a tool-call filter, not an operating-system sandbox. It blocks protected paths and recognized critical operations, but cannot inspect all effects of an approved command, script, external tool, or a process already running. bi's own command and destructive-operation confirmations still apply after the mode gate, including in Bypass. Auto ships without a network reviewer and asks when its static policy cannot decide.

## System prompt

Honeycomb uses its own system prompt — pi's default system instruction is fully
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
node --experimental-transform-types --test tests/tools/tools.test.ts # run one test file
```

Host-provided packages (`@earendil-works/pi-coding-agent`, `typebox`, etc.)
are declared as optional `peerDependencies` — pi supplies them at runtime.
