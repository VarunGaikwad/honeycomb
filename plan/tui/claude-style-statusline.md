# Claude-style statusline for Bi

**Status:** Implemented for Pi's interactive TUI. Typecheck and automated tests passed; a live TUI smoke test has not been recorded.

## Layout

```text
Opus 4.6 · high │ ▰▰▰▱▱▱▱▱▱▱ 30% of 200k │ 💬 12 │ bi main ●
↓ 128.4k in ↑ 8.1k out │ cache R 110.0k W 4.0k (86% hit) │ 42s API / 8m12s elapsed │ est. $0.432 │ opus + sonnet
⏸ manual mode on (shift+tab to cycle)
```

The first two rows follow the Claude layout. Keep Bi's permission indicator on its own row in detailed mode; do not sacrifice it for stats. Offer `ui.footerStyle: "detailed" | "compact"`, defaulting to `detailed`, with the existing footer as the compact option. Use short labels and drop secondary fields on narrow terminals before clipping; use Bi's existing ASCII, theme, sanitization, and display-width helpers. RPC/JSON/print output stays unchanged.

## Field mapping

| Field | Pi source and behavior |
| --- | --- |
| Model and thinking | `ctx.model` and current Pi thinking level. Keep the selected model primary so `/model` updates immediately and the context bar stays meaningful. Show `last: <model>` when the latest reply on the active branch differs (including routed requests); no Claude-only model-name parsing. |
| Context | `ctx.getContextUsage()` provides percent and window size. Render a 10-cell bar at known percentages; show `?` instead of `0%` when unknown, such as just after compaction. |
| Prompts | Count persisted user-message entries once per entry, not tool/assistant messages or retries. This is a user-message count, not Claude's `prompt_id`; prompts submitted via an extension also count if Pi persists them as user messages. |
| Folder, branch, dirty | Reuse Bi's folder display, `footerData.getGitBranch()`, and its existing bounded, cancellable read-only Git status poll. No new shell commands. |
| Tokens, cache and cost | Sum reported usage across all models and all persisted session entries via `getEntries()`, including earlier branches and pre-compaction history, as Pi's built-in footer does. Count each entry once. Include assistant, standalone usage, and tool/summary/compaction usage when recorded; do not also add live `message_update` totals. Input shown is `input + cacheRead + cacheWrite`; hit rate is `cacheRead / input shown`, omitted when the denominator is zero. For the optional multi-model list, use provider/model identifiers from entries that report them; show it only when more than one is known. Use `usage.cost.total` when available and label catalog-derived numbers as estimates, not invoices. |
| Time | Sum recorded assistant `durationMs` as observed API time; omit it if none exists and mark partial coverage when entries lack timing. Wall time is elapsed since the session header timestamp, including time away from a resumed session. It is not active work time. |
| Lines added/removed | Defer until defined. Git `--numstat` would measure the current worktree delta, not session edits. For closer parity, a follow-up could record counts only for successful Bi edits with available before/after data and label them `Bi edits`; shell/other-extension changes would remain untracked. Do not display fake zeros. |

Session totals intentionally match Pi's all-entry accounting: `/tree` changes the active reply/context, not the totals; a fork includes any history copied into the new session. No Claude transcript reader, sidecar files, external requests, or provider billing lookups.

## Implementation order

1. Add `src/tui/footer-stats.ts` to aggregate transcript metadata separately from rendering. Cache totals by session/leaf and invalidate when persisted entries change; use Pi's event lifecycle to refresh, and rebuild on session replacement. Avoid scanning or diffing model content or reading transcript files directly. Check that refreshes see persisted entries: Pi dispatches `message_end` before appending the entry in the installed runtime.
2. Add a testable renderer in `src/tui/footer.ts` and wire it into the existing `installTui`. Preserve the permission subscription and Git cleanup. Refresh on model/thinking changes, transcript changes and tree navigation; reuse the existing timer for elapsed time and stop it on footer disposal. Keep active context separate from session totals.
3. Add the enum to Bi's UI defaults and project preference allowlist, document both layouts in `README.md`, and leave all permission and Git policies unchanged.
4. Test multi-model usage, cache math, missing/partial usage and timing, resume/fork/tree/compaction, and model selection before the next reply. Test width limits, ASCII and ANSI/control-character handling, Git failure, compact mode, permission badge visibility, repaint and disposal. Run `npm run typecheck`, focused footer tests, and `npm test`, then smoke-test the TUI with `pi -e ./` in an authorized session.
