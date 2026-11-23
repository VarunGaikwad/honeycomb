# Bi extension roadmap: review, diagnostics, tasks, rewind, and side questions

**Status:** Proposed. Each phase should be independently reviewable and shippable. Implement from Bi's code and Pi's public APIs; do not copy or ship anything from `temp/`.

| Order | Command | First release | Size |
| --- | --- | --- | --- |
| 1 | `/diff [staged\|unstaged]` | Browse changed files and hunks without asking a model | M |
| 2 | `/doctor` | Explain which settings, tools, and shortcuts are actually in effect | S–M |
| 3 | `/tasks` | See the current goal, todos, and latest reported verification together | M |
| 4 | `/rewind` | Preview and restore the last supported Bi file operation | L |
| 5 | `/btw [question]` | Ask a separate, tool-free question without changing the main conversation | M |

## Shared design

- Register commands through `src/commands/index.ts` and `src/index.ts`. Keep command handlers thin: authorization, data collection, and rendering should be testable separately. Reuse Pi's `ctx.ui.custom()` and Bi's `src/tui/text.ts` for width limits and literal rendering. Do not replace the editor or add global shortcuts for these commands.
- TUI is the primary interface. `/doctor` and `/tasks` can return bounded plain-text notifications in RPC. `/diff`, `/rewind`, and `/btw` are TUI-only for the first release. Unsupported modes must not prompt, write, make model requests, or print stray output into JSON/RPC streams. Start modal commands only when Pi is idle and has no queued input.
- Slash commands do not go through Pi's `tool_call` event. For `/diff` and `/rewind`, explicitly reuse Bi's TypeScript permission checks and prompter from `src/extension/permission-modes/`. Do not treat `dispatcher.dispatch()` as authorization, route through arbitrary shell commands, or let project preferences grant permission. Recheck the session, permission mode, and rules after approval; reject stale approvals.
- Keep recent output, state, and requests scoped to the active session or branch as specified below. Escape closes the view and cancels outstanding work owned by it. Render filenames, errors, model output, and other untrusted text literally; do not add them to model context or logs just to display a screen.

## 1. `/diff`: interactive change review

**UX:** Open on unstaged changes by default. Tab switches between unstaged and staged, arrows select a file, Enter opens its patch, and Page Up/Down scrolls hunks. Show clear states for clean changes, binary changes, oversized patches, and missing Git/repository. Untracked contents and submodule internals are out of scope for v1; say so in the viewer. No staging, restore, or model review buttons.

**Build:**

1. Refactor the read-only portion of `src/tools/git.ts` into a shared backend while keeping the current `git_diff` tool interface. Enumerate files from NUL-delimited Git metadata; load one selected patch on demand with literal pathspecs and `--`, using both paths for renames. Authorize the selected staged/unstaged view using existing `git_diff` rules before reading it. Resolve paths against the repository root. Apply existing sensitive-path checks before exposing any sensitive names or hunks and recheck the actual patch paths if the worktree changed after listing. Hidden paths require fresh approval; unclassifiable paths fail closed.
2. Retain bounded, cancellable `execFile` calls. Disable external diff, textconv, worktree filters, fsmonitor, pager, optional index writes, and lazy fetching as appropriate to the read-only helper. Cancel obsolete reads when switching tabs or files; don't repaint with a stale result. Show an explicit limit marker or an error, not an apparently complete patch when the cap is hit.
3. Add `src/commands/diff.ts` and a small viewer in `src/tui/`. A two-step list/patch screen is sufficient, including in narrow terminals.

**Done when:** Fixtures cover staged and unstaged changes to the same file, an unborn branch, a nested working directory, rename/delete/binary changes, unusual filenames, sensitive denial, and large/cancelled output. The index and worktree remain unchanged, repository-configured helpers are not invoked, and no model call or session entry is created.

## 2. `/doctor`: read-only local diagnostics

**UX:** Show `OK`, `Warning`, or `Blocked` with an actionable next step for each problem. Report effective Bi preferences and their sources (package default or project override), disabled vs. registered-but-inactive tools, the permission mode and invalid rule source, Git availability, and Bi's known shortcut conflicts or editor fallback. Refer users to `/permissions` for actual rules and `/hotkeys` for the full bindings list.

**Build:**

1. Expose redacted, structured diagnostics from the existing loaders (`src/config/project.ts` and `src/extension/permission-modes/rules.ts`) so the report and runtime use the same validation. Distinguish missing, invalid, ignored, and effective values. Bound file reads and don't follow unsafe paths just to explain a diagnostic. Show only known preference keys and safe values; for `systemPrompt.additional`, show present/ignored without the text. Never show raw config, rules, parser exceptions, environment values, or auth details.
2. Compare configured tool groups with `pi.getAllTools()` and `pi.getActiveTools()`; distinguish a tool hidden by Plan mode from a disabled group. Use a short, fixed read-only Git availability/repository probe. Use Bi's actual editor install result and Pi's effective keybindings where exposed (including the Shift+Tab and Alt+T behavior); report `not inspectable` if a mapping cannot be verified. Do not auto-repair or run commands read from config.

**Done when:** The report correctly explains an invalid rule file, malformed and out-of-range project preferences, Plan mode, a disabled group, missing Git, and another extension owning the editor. A sentinel secret in config or a parser error never reaches output. No files or settings change when running the command.

## 3. `/tasks`: goal and todo dashboard

**UX:** Show the current goal, status, iteration budget and remaining automatic continuations, latest progress or blocker, latest reported verification, and open/completed todos. Show useful empty states, including when there is no goal or the agent tool group is disabled. The dashboard does not change state; manage goals using the existing `/goal` subcommands.

**Build:**

1. Build the goal view with `readGoalState` from `src/commands/goal/state.ts` and pass it `ctx.sessionManager.getBranch()`. Add an optional, bounded verification field to `goal_report` and saved goal state (`passed`, `failed`, or `not_run` plus a short summary). Old reports remain valid; absent evidence is `Not reported`. Label evidence as agent-reported, never independently verified. A new or edited objective starts with no verification; display earlier evidence for the same goal only as the last report.
2. Extract the private todo array from `src/tools/agent.ts` behind a small store shared by the tool and dashboard. In Pi, store validated, bounded todo snapshots as `bi.todos` custom session entries on successful mutations; project the most recent valid snapshot on the active branch via `getBranch()`. Serialize mutations via the existing tool registration seam in `src/extension/register-tools.ts`, not mutable global UI context. Keep `todo` actions and IDs compatible and provide an in-memory store for standalone tool-system use. Older transcripts without the new entries start with an empty list.
3. Keep dashboard queries read-only: no appending entries, prompting a model, running checks, or changing goal scheduling.

**Done when:** `/tasks` reflects a goal changing from active to blocked/completed and shows old reports without inventing evidence. Todos survive reload/resume, follow Pi's branch history, and do not leak into a new session. Multiple todo updates don't lose data, and the exactly-one-`goal_report` and iteration budget tests still pass.

## 4. `/rewind`: restore one operation safely

**UX:** Preview the most recent tracked operation and all affected paths (including any file that would be removed), then confirm or cancel. Repeat to step back further; no arbitrary target selection or redo in v1. Rewind changes files only: it does not move Pi's conversation tree, Git HEAD, or the index. Shell/terminal, Git, move/copy/delete, and automatic restore on `/tree` or `/fork` are out of scope.

**Build:**

1. Replace `apply_patch`'s private undo stack with a shared in-memory journal for successful Bi `edit`, `write`, and `apply_patch` operations. Scope it to the current session and canonical workspace, and clear it on branch change, reload, or session switch. Use one record per operation, with bounded original bytes, prior existence/mode, and expected post-write fingerprints. Start with caps of 20 operations, 8 MiB total, and 1 MiB per file. Opt out of capturing protected, outside, linked, binary, or oversized files. If a recent mutation cannot be tracked safely, treat it as a boundary instead of silently rewinding past it. For a new file, remove only that file, never its parent directories.
2. Keep the `undo` tool's empty-argument interface but route it and the new command through the same restore service. Evaluate current `undo` rules and applicable write/delete restrictions against the actual targets. Always require a fresh destructive confirmation, including in Edits, Auto, and Bypass; reject Plan, No prompts, and callers without an approval callback. Do not record approval in the session cache.
3. Before showing the preview and again before writing, verify lexical and resolved containment, reject symlinked path components, and check regular single-link targets and expected post-write content/metadata. Serialize Bi's tracked writes with restore; revalidate as close as possible to filesystem commits. Refuse the whole operation on any preflight conflict. On an I/O failure mid-restore, report partial effects and attempt only safe rollback; don't claim multi-file atomicity or drop a record as if restore succeeded. After a successful restore, invalidate affected `edit` read snapshots and keep earlier eligible records usable.

**Done when:** Restore tests cover an overwrite, a newly created file, a multi-file patch, and repeated undo. Later user edits, changed paths/links, changed rules after preview, denial, cancellation, switch/reload, and Plan or headless use cannot overwrite files. Tests simulate mid-restore failure and check bytes, permissions, and honest error reporting. No snapshot bytes are written to the session transcript.

## 5. `/btw`: isolated model question

**UX:** `/btw <question>` previews the question and active provider/model before sending. Bare `/btw` opens a separate input field so the question need not go into Pi's main editor history. Show the answer in a cancellable overlay with token usage and estimated cost when available (otherwise `Unavailable`). This is separate from `/session` totals. Idle-only for v1; asking while the main agent streams is a follow-up, not a promise.

**Build:**

1. Use the active model via public `ctx.modelRegistry.streamSimple()`, not `pi.sendUserMessage()` or another agent session. After explicit Send, pass only a fixed side-answer instruction and the question the user typed or pasted. No transcript, project files or instructions, attachments, provider switching, or tools. Ignore unexpected tool-call blocks; never execute them. Reject in Plan and No prompts modes for v1. Do not source request settings from project config.
2. Use a separate request identifier, disable continuation and local extension persistence, and request no provider prompt caching where supported. These options do not promise the provider retains nothing; disclose that the question goes to the selected provider. Also distinguish non-persistence in the Bi transcript from Pi's normal command-input history when arguments are typed inline.
3. Cap input, reply, and request duration (initial values: 4,000 characters in, 512 output tokens, 30 seconds). Allow one request at a time, abort on Esc/session shutdown, ignore late results, and don't auto-retry. Show safe missing-model, auth, timeout, and provider-error messages without dumping provider payloads.

**Done when:** A mock registry receives exactly the approved question and fixed instruction, with no tools or main-session data. Success, provider failure, cancellation, and timeout leave the main branch, goal, and tool state unchanged. Unsupported/busy invocations and a dismissed preview send zero requests. Usage appears in the overlay and not in a new transcript entry.

## Release checklist

- [ ] Record the existing test baseline before starting; keep each phase in a separate PR and don't mix unrelated permission/TUI changes into it.
- [ ] For each phase, ship unit tests for the non-UI service, command tests with mocked Pi context, and relevant real Git/filesystem fixtures. Run `npm run typecheck` and `npm test` on Node.js ≥22.19.0.
- [ ] Smoke-test with `pi -e ./`: narrow TUI, cancellation, `/tree`, `/reload`, and relevant permission modes. Verify the installed and locked Pi versions support the APIs used. Keep source and test files under 1,000 lines.
- [ ] Update `README.md` as phases ship: command examples, unsupported modes, permission behavior, and any data sent or retained. Keep `temp/` out of commits and package contents.

**Later, not part of this roadmap:** live `/btw` while the agent runs, user-selected context sharing, persistent rewind history, automatic memory writes, remote control, and background agents. Pi already provides `/tree`, `/fork`, `/session`, and `/hotkeys`; don't duplicate them.
