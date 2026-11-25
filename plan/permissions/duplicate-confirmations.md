# Duplicate confirmation audit and fix plan

**Status:** Audit complete; broader fix not implemented. The existing `git_commit` change already shows one prompt. Scope: Bi-owned source, registered tools, slash commands, and permission UI. Other installed Pi extensions may have independent policies; this plan does not suppress their prompts.

## Reproduced

The [`tool_call` hook](../../src/extension/permission-modes/index.ts#L177) applies mode and permission rules. Later, [`registerTools`](../../src/extension/register-tools.ts#L92) provides confirmation callbacks to tools. A tool can request its own confirmation even after the user already approved the same operation at the hook. The [dialog queue](../../src/tui/permission-dialog.ts#L69) serializes those requests; it does not create the duplicates.

| Flow | Current behavior in Manual mode |
| --- | --- |
| [`git_add`, `git_checkout`, `git_branch` with `name`](../../src/tools/git.ts#L57) | Two each: `Allow git_…?` then stage/switch/create confirmation. Listing branches without `name` has no prompt by default. |
| [`delete`](../../src/tools/filesystem.ts#L157) | `Delete path?` then `Confirm delete` with the resolved path. The current exact-session choice only skips the first dialog. |
| [`bash`, `background`, `terminal` start](../../src/tools/execution.ts#L83) | The gate previews the command, then `confirmCommand` asks about the same command. For `bash`, both dialogs can have the same title. |
| [`terminal` input](../../src/tools/execution.ts#L118) | `Send input to terminal?` then `Run shell command?` for the same input and process. This is separate from starting the process. |
| [`run_code`](../../src/tools/execution.ts#L137) | `Allow run_code?` shows the JavaScript, then `Run shell command?` shows the generated Node invocation for that same code. |
| [`undo`](../../src/tools/agent.ts#L237) | `Allow undo?` has no file details, then the confirmation lists actual restore/remove targets. Keep the second dialog's detail; remove the empty one. [`/rewind`](../../src/extension/register-tools.ts#L51) dispatches directly and already shows one detailed prompt. |
| [`git_commit`](../../src/tools/git.ts#L51) | Already fixed: `Commit staged changes?` with the message, once per approved call. |

When the gate already allows an operation, there may be only one prompt today. For example, Bypass still requires one tool-level confirmation for an eligible `delete` or a classified `bash` call; unclassified shell commands can still produce two. Edits and the shipped Auto mode do not remove execution or Git mutation approvals. The packaged tool system does not supply `allowCommand`; explicit host-supplied command policies are separate from dialog deduplication.

## Repeats that need different treatment

- **`git_diff` and `/diff` — keep the sensitive-read check.** By default an ordinary tool diff does not prompt; a sensitive diff prompts once. An explicit `git_diff` Ask rule and a sensitive result can mean two decisions: whether to open the diff and whether to reveal sensitive data discovered by [`runDiff`](../../src/tools/git.ts#L85). Do not reuse the first approval to disclose that data.
- **`/diff` navigation — confirmed extra prompt.** With a sensitive changed file, approving its listing, opening its patch, then pressing Esc back to the *same unchanged list* asks about the list again. [`diff.ts`](../../src/commands/diff.ts#L103) resets the sensitivity approval on navigation; switching staged/unstaged also resets the rule approval. Listing filenames and showing patch contents are different scopes, but returning to an unchanged, already approved view in the same `/diff` invocation need not ask again.
- **`/init` on an existing `AGENTS.md` — overlapping wording.** [`/init`](../../src/commands/init.ts#L21) asks to regenerate before it starts analysis; the later `write`/`edit`/`apply_patch` may ask about the actual proposed change. This can feel like a repeat, but the first Yes never saw the content. Don't treat it as permission for a future write. Clarify the first prompt in a separate change; if the flow should have just one confirmation, defer it to the exact root-file proposal and explicitly require it even in modes that allow ordinary edits.
- **No duplicate found in Bi itself:** `write`/`edit`/`apply_patch` and other gate-only tools (e.g. `move`, `copy`, `kill`) have no second tool-level dialog. Bypass startup, `/btw` provider consent, and Plan approval are separate decisions. Rewriting the same Plan note does not prompt again; opting into Manual after approving a plan still means individual edits may ask. `ask_user` is a question, not permission.

## Implementation order

### 1. Establish one approval path for tools that always ask

1. Keep `decidePermission()` and the `tool_call` hard blocks in place. For a verified Bi-registered handler that always reaches a confirmation before its side effect, defer the **dialog**, not policy enforcement, to its execution callback. `deny`, invalid config, and Plan restrictions still block at the gate. Preserve the existing gate path for gate-only, unknown, disabled, or externally overridden tools; do not defer based on a tool name alone (notably `bash`). Verify ownership against the active registration; if ownership cannot be established, keep the gate prompt.
2. Use a per-call pending decision and a typed operation request at the callback instead of deduplicating by title or copying the `git_commit` special case into each handler. The callback presents one preview with the policy reason (including explicit Ask rules), actual operation, and target. The pending decision is **not** permission. Only an explicit Yes approves that specific action. Default to No; dismissals, UI errors, cancellation, `dontAsk`, or missing UI cannot grant approval. When the gate has an `allow` decision, e.g. Bypass, the required tool confirmation still runs once.
3. Bind the decision to call ID, operation kind, session and branch/mode epoch, canonical `cwd`, validated arguments, and the actual target or process identity. Recheck relevant rules, target/effect, and both cancellation signals after the dialog, before the side effect. Reject missing, changed, expired or replayed decisions instead of broadening or reusing approval. Clear pending decisions on completion/abort and session, branch, or mode changes. Keep exact-session approvals for eligible ordinary edits; remove the session option for destructive `delete` rather than letting it skip the only remaining confirmation. Never save approval for execution, Git mutation, or undo.
4. Keep existing command and destructive authorization for standalone tool consumers. Do not replace `confirmCommand` with an allow-all policy or change the precedence of an explicit host `allowCommand`. Use the existing serialized prompter and literal rendering; leave the tool schemas and permission config format unchanged.

### 2. Migrate the confirmed duplicate flows

- **Git and delete:** Use action-specific prompts. Show the resolved deletion target (and that directory deletion is recursive), each staging pathspec separately, the named branch/ref, or the commit message. Recheck path/descendant protections before deleting. Preserve Git validation and pathspec semantics; don't describe unexpanded pathspecs as a resolved file list. Retire the commit-specific approval map only once its single-prompt and stale-approval tests pass under the shared flow.
- **Execution:** Show the exact command and whether it's foreground, background, or a terminal start. For `run_code`, show the exact JavaScript and identify the Node.js execution; ensure it is the source actually passed to Node. For terminal input, show the text and process ID, recheck the same writable process before sending, and never reuse launch approval for input. Keep shell hard-denial classification and cancellation behavior intact.
- **Undo:** Let journal preflight select the operation, check affected paths and hashes, then show the sole Restore/Remove preview. Keep the recheck after the dialog and before changes, including each target's current write/delete policy. An empty journal or stale operation returns without an approval prompt. Keep `/rewind` on the same detailed restore path without routing it through a new gate dialog.

### 3. Fix `/diff` navigation separately

Split sensitive listing and patch scopes. Retain consent for the same verified view only within one open viewer, keyed by repo, staged/unstaged, listing vs. patch, selected paths/snapshot, and permission context. On return to an approved view, reuse only the same data or verify it is unchanged. Never reuse a listing approval for patch contents, or reuse an approval if sensitive paths/data or policy changed. Do not simply retain `sensitiveApproved = true` across navigation. Recheck current rules and context before exposing any previously approved data. Keep independent rule and sensitive-data checks; use distinct prompt titles so the two decisions are clear.

## Acceptance checks

- Add integration tests that traverse the real `tool_call` handler, registered tool, and dispatcher in a fake Pi host. For all ten reproduced duplicate tool variants and `git_commit`, assert **one dialog** and the intended effect on Yes; **no effect** on No, Esc, or UI failure. Exercise Manual, Edits, Auto fallback, Bypass, matching Ask and Deny rules, Plan, `dontAsk`, and UI-less calls. Assert required approvals are not silently skipped in Bypass.
- Prove that changed args/resolved paths, removed or changed rules, managed process or undo target changes, cancellation, mode/branch/session changes, duplicate IDs, and parallel calls cannot reuse consent. Test a foreign or overridden tool still gets normal gate handling. Confirm explicit standalone command policies still work as before.
- Add `/diff` tests for list → patch → back, tab switching, and a changed sensitive result; previously authorized unchanged view should not reprompt, a new scope must still ask, and denied sensitive names/content must not appear. Cover `/rewind` once with fresh journal data and no prompt for empty/stale history. Run `npm run typecheck` and `npm test`, then smoke-test TUI prompts in a scratch repo and update `README.md` when behavior ships.

**Audit baseline:** Reproduced prompt counts with the registered tools and mocked Pi UI against temporary Git/filesystem fixtures; exercised the `/diff` navigation loop with a fake TUI. `npm run typecheck` and all 117 existing tests passed. No live model/TUI session was needed for the audit.
