# Permission Modes

## Plan mode

Plan mode filters active tools to verified built-in read tools and the dedicated
`save_plan` capability, while the policy hook independently denies Bash, general
writes, and unknown tools. A prompt instructs the agent to plan and save a revision;
saving alone does not authorize implementation. At agent settlement an interactive
user may approve the latest verified persisted revision for `acceptEdits` or `default`,
keep planning, or discard and return to default. Approval restores the saved tool list
and invokes `sendUserMessage()` once with the exact approved revision. Noninteractive
sessions do not prompt or hand off.

Handoff semantics are one API invocation per accepted approval within the active
session, with no automatic retries. A synchronous exception is reported; the approval
is consumed and the mode/tool transition remains in effect, so the user must save and
approve a new plan to retry. Pi 1.5.2's ExtensionAPI declares `sendUserMessage()` as
returning `void`; asynchronous delivery failures are reported by Pi and cannot be
observed or acknowledged by this extension. Successful delivery is therefore not
guaranteed. This is not crash-safe or distributed exactly-once delivery.

The policy hook and active-tool filtering are not an OS sandbox. They cannot
confine code already running in the Pi process or protect against concurrent
filesystem modification by other processes.

## Milestone 5 security scope

In scope are malicious or unexpected agent tool calls, prompt injection, arbitrary
writes through exposed tools, path traversal, pre-existing symlinks in the storage
path, unintended overwrites, incorrect mode transitions, and unauthorized or stale
approvals. A separate malicious process with the same OS privileges actively
replacing filesystem entries during writes, compromised extension code or Node.js,
and OS-level sandbox isolation are out of scope. Plan storage checks reject
pre-existing symlinks, traversal, and collisions, but pathname validation does not
eliminate concurrent filesystem races. This extension is not an OS sandbox: permitted
commands such as `npm test` may execute arbitrary project code.

## Plan storage investigation (historical)

The following investigation considered a broader threat model than the explicitly
scoped Milestone 5 model above.

| Approach | Guarantees and dependencies | Concurrent replacement and spec outcome |
| --- | --- | --- |
| Node path checks + `O_NOFOLLOW` | `O_NOFOLLOW` protects the final component on supporting systems. Node's standard API here has no `openat`/`openat2`/`renameat2`. | An intermediate directory can be swapped between checking and opening. Does not satisfy the spec. |
| Linux directory descriptors via `/proc/self/fd` | Linux and a usable procfs can anchor operations to an open directory; `O_DIRECTORY`/`O_NOFOLLOW` can reject symlinks while opening components. | Non-portable, and a directory can be renamed after opening; secure creation, updates, ownership, and behavior on missing procfs still need verification. Not adopted. |
| Native OS helper | An OS-specific helper using directory-relative primitives could reduce pathname races. It requires a native executable, platform-specific APIs and deployment/build or external code outside this no-build, no-new-dependencies extension. | Correctness would depend on platform and precise atomic operations, including directory renames and safe updates; not verified or adopted. |
| Private extension-controlled directory | Restrictive ownership/permissions can prevent other users from replacing entries on a properly configured filesystem. | Same-user processes or privileged actors can still replace entries; moving storage outside `.pi/plans/` also changes the spec. Permissions reduce exposure, not eliminate races. |
| Session-only in-memory plan | No filesystem traversal or write race; data lives only within the Pi process and is lost on reload/exit. | Cannot meet the required `.pi/plans/<session>.md` persistence; approving or executing an unsaved plan is explicitly disabled. |

The adopted threat model excludes active same-user replacement races; this
historical analysis does not imply race-free filesystem operations.

## Known limitations

- Read-only Git commands are not guaranteed to be side-effect-free. Git can execute repository-configured commands through settings such as `core.pager`, `core.fsmonitor`, and `diff.external`. Do not treat an allowlisted Git command as a sandbox when working in an untrusted repository.
