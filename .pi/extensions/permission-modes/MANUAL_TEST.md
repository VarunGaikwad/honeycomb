# Manual test checklist (Milestone 4)

These checks require Pi 1.5.2 and an interactive TUI. They are a checklist only; they have **not** been run as part of automated verification.

1. Start a project with the extension loaded (for example, `pi -e ./.pi/extensions/permission-modes/index.ts`). Confirm the footer shows `● manual`.
2. Run `/mode`; confirm it prints the current mode and only `default`, `acceptEdits`, and `bypassPermissions` as available modes.
3. Run `/mode acceptEdits`; confirm the footer changes to `✎ edits`. Use `alt+m` to cycle to `default` and back. Confirm each change remains visible in the footer.
4. In `default`, request a file edit. Confirm Pi presents **Allow once / Allow for this session / Deny**. Test each choice; an exact session approval should not approve a changed tool input.
5. Run `/mode bypassPermissions` without the startup flag. Confirm it is refused. Restart with `pi --permission-mode bypassPermissions -e ./.pi/extensions/permission-modes/index.ts`; confirm `⚡ bypass` appears.
6. From that flagged session, switch to `default`, then `/mode bypassPermissions`. Confirm one confirmation dialog is required; cancel once and confirm the mode does not change, then approve and confirm the badge updates.
7. Switch to `acceptEdits`, restart or resume the same session without a mode flag, and confirm the last persisted mode is restored. Start with `--permission-mode default` and confirm the CLI selection overrides the saved mode.
8. In a non-interactive invocation, cause a policy `ask` (for example, an edit in default mode). Confirm it is blocked rather than silently allowed or prompted.
9. In bypass mode, attempt a hard-denied operation covered by the policy (for example, `rm -rf ~` or writing `.env`). Confirm it remains blocked.
