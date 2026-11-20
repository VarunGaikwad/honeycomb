# Permission Modes: verified Pi API

## Installation checked

- `pi --version`: **1.5.2**; Node.js: **v24.22.2**.
- Installed package: `@earendil-works/pi-coding-agent` **1.5.2**, at `~/.pi/agent/install/releases/1.5.2/node_modules/@earendil-works/pi-coding-agent`.
- Use imports from `@earendil-works/pi-coding-agent` for Pi extension types and helpers. Pi provides this package at runtime; no package manifest or third-party dependency is needed.
- Read the installed `docs/extensions.md` and the requested official examples (`permission-gate.ts`, `protected-paths.ts`, `confirm-destructive.ts`, `plan-mode/`, `status-line.ts`, `tools.ts`). Also checked `docs/keybindings.md` and installed declaration files for signatures below.

## APIs used by the extension

### Tool interception and narrowing

The installed `ExtensionAPI` declaration provides:

```ts
on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): () => void;
type ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;
interface ToolCallEventResult { block?: boolean; reason?: string; terminate?: boolean; }
```

Return `{ block: true, reason: "..." }` to stop a call. A reason can be included for every block so the model receives an explanation. The helper is exported and has built-in overloads, including:

```ts
isToolCallEventType(toolName: "bash", event: ToolCallEvent): event is BashToolCallEvent;
isToolCallEventType(toolName: "read", event: ToolCallEvent): event is ReadToolCallEvent;
isToolCallEventType(toolName: "edit", event: ToolCallEvent): event is EditToolCallEvent;
isToolCallEventType(toolName: "write", event: ToolCallEvent): event is WriteToolCallEvent;
isToolCallEventType(toolName: "grep", event: ToolCallEvent): event is GrepToolCallEvent;
isToolCallEventType(toolName: "find", event: ToolCallEvent): event is FindToolCallEvent;
isToolCallEventType(toolName: "ls", event: ToolCallEvent): event is LsToolCallEvent;
```

There is also a generic overload for other tool names and input records. Pi 1.5.2's built-in tools are `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, and `ls`. The spec's read-only set (`read`, `grep`, `find`, `ls`) is present; `powershell` is not in that set and will be handled conservatively as an unknown tool.

The installed tool declarations confirm these `tool_call` input fields: `bash`/`powershell` use `{ command, timeout? }`; `read` uses `{ path, offset?, limit? }`; `edit` uses `{ path, edits }`; `write` uses `{ path, content }`; `grep` uses `{ pattern, path?, glob?, ignoreCase?, literal?, context?, limit? }`; `find` uses `{ pattern, path?, limit? }`; and `ls` uses `{ path?, limit? }`. The adapter passes the event's `toolName` and record-valued `input` directly to the pure policy as `{ toolName, input }`; non-record inputs are blocked. These schema fields were verified in the installed package's `dist/core/tools/*.d.ts` declarations.

### Lifecycle, prompt, session state, and messages

```ts
on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): () => void;
on(event: "before_agent_start", handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>): () => void;
on(event: "agent_end", handler: ExtensionHandler<AgentEndEvent>): () => void;
on(event: "agent_settled", handler: ExtensionHandler<AgentSettledEvent>): () => void;
```

`session_start` supplies `reason: "startup" | "reload" | "new" | "resume" | "fork"`. Session entries can be inspected through `ctx.sessionManager.getEntries(): SessionEntry[]` or `getBranch(fromId?: string): SessionEntry[]`; entries with `type === "custom"` expose `customType` and `data`. `pi.appendEntry<T = unknown>(customType: string, data?: T): void` persists extension state. Restore from the active branch to avoid using state from an abandoned branch.

`before_agent_start` exposes the user prompt on user-started runs and allows a returned `{ systemPrompt?: string }` to replace the complete prompt for that turn. It also accepts a returned custom `message` with `customType`, `content`, and `display`. The latest user goal can be captured from this event's `prompt` field.

`pi.sendUserMessage(content: string | (TextContent | ImageContent)[], options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean }): void` exists for sending a kickoff user message. When the agent is streaming, specify `deliverAs`; when settled/idle, it can be sent directly.

**Lifecycle note:** `agent_end` is not necessarily final; Pi may retry, compact, or continue. For the plan approval UI after the run is truly finished, use `agent_settled` (which is final and notification-only) rather than prompting on every `agent_end`.

### Commands, shortcuts, and CLI flags

```ts
registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void;
// RegisteredCommand.handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>
// Optional completion: (argumentPrefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>

registerShortcut(shortcut: KeyId, options: {
  description?: string;
  handler: (ctx: ExtensionContext) => Promise<void> | void;
}): void;

registerFlag(name: string, options:
  | { description?: string; type: "boolean"; default?: boolean }
  | { description?: string; type: "string"; default?: string }
): void;
getFlag(name: string): boolean | string | undefined;
```

The installed `registerFlag` declaration supports `type: "string"`, and `getFlag` is documented. The installed 1.5.2 CLI parser/runtime was also checked: extension flag names are exposed verbatim as `--<name>`, and string values for registered extension flags are made available to `getFlag`. Thus `registerFlag("permission-mode", { type: "string" })` supports `--permission-mode <mode>` and reading it during `session_start`. Command argument completion is documented and can be used for mode names.

`shift+tab` is Pi's default `app.thinking.cycle` binding. Use **`alt+m`** for the mode-cycle shortcut; it is not listed among default bindings in the installed keybindings reference. **UNVERIFIED:** a user's custom keybindings could assign `alt+m` and cause a conflict.

### Active tools and tool metadata

```ts
getActiveTools(): string[];
getAllTools(): ToolInfo[];
setActiveTools(toolNames: string[]): void;
```

These APIs support saving/restoring the active list and removing tools in plan mode. `ToolInfo.annotations` may contain MCP-style `readOnlyHint` / `destructiveHint` metadata, but the docs explicitly treat annotations as unverified hints, not a reliable write-capability declaration. **Plan-mode fallback:** retain known read-only built-ins and hide all other unclassified tools, rather than attempting to identify only unknown write-capable tools. The `tool_call` policy remains the second enforcement layer.

### UI and extension context

`ExtensionContext` has `hasUI: boolean`, `cwd: string`, `ui`, `sessionManager`, `modelRegistry`, and `model`. The docs specify `hasUI` is true in TUI/RPC and false in print/JSON mode; check it before dialogs, and deny unresolved `ask` decisions when it is false.

```ts
ui.select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined>;
ui.confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean>;
ui.notify(message: string, type?: "info" | "warning" | "error"): void;
ui.setStatus(key: string, text: string | undefined): void;
ui.setWidget(key: string, content: string[] | undefined, options?: ExtensionWidgetOptions): void;
```

`setStatus` is the documented footer/status badge API; `setWidget` is available if additional UI is needed. Dialog cancellation/timeout is not approval (`select` returns `undefined`, `confirm` returns `false`).

### Model calls for auto mode

A model call through the configured provider/authentication is supported. `ctx.modelRegistry` is a `ModelRegistry`; its installed declaration includes:

```ts
complete<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: ModelsApiStreamOptions<TApi>
): Promise<AssistantMessage>;

streamSimple(
  model: Model<Api>,
  context: Context,
  options?: ModelsSimpleStreamOptions
): AssistantMessageEventStream;

classify(
  model: ClassifierModel<ClassifierApi>,
  context: ClassifierContext,
  options?: ModelsClassifierOptions
): Promise<ClassifierResult>;
```

The docs state these use configured providers and request-time authentication; classifier models are separately discoverable and extensions can call `ctx.modelRegistry.classify()` directly. Auto mode can use the documented structured classifier API. **UNVERIFIED:** using the optional current `ctx.model` with `complete`/`streamSimple` as the auto-mode judge is inferred from the documented generic `model` parameter and `ctx.model` property; the docs do not specify this exact classifier design. If no model is available, the model call fails, times out, or output is invalid, fall back to `ask`.

## Requested API signature/source audit (Pi 1.5.2)

The signatures below are from the installed declarations; each entry also names the official docs/example used to verify its behavior.

### (a) Making an LLM call from an extension

```ts
streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream;
complete<TApi extends Api>(model: Model<TApi>, context: Context, options?: ModelsApiStreamOptions<TApi>): Promise<AssistantMessage>;
```

`streamSimple()` and `complete()` are methods on `ctx.modelRegistry`. Sources: installed `docs/extensions.md`, “ExtensionContext” → “ctx.modelRegistry / ctx.model / ctx.thinkingLevel / ctx.scopedModels” → “Streaming model calls”; installed `dist/core/model-registry.d.ts` (exact signatures). For structured classifiers, `classify(model, context, options?): Promise<ClassifierResult>` is also declared there; see installed `docs/models.md`, “Use classifier models” (extensions call `ctx.modelRegistry.classify()`). **UNVERIFIED:** selecting optional `ctx.model` as the permission judge is an implementation inference; the docs verify model calls through `ModelRegistry`, not this specific classifier design.

### (b) Shortcut registration and Shift+Tab conflict

```ts
registerShortcut(shortcut: KeyId, options: {
  description?: string;
  handler: (ctx: ExtensionContext) => Promise<void> | void;
}): void;
```

Sources: installed `docs/extensions.md`, “ExtensionAPI Methods” → `pi.registerShortcut(shortcut, options)`; installed `dist/core/extensions/types.d.ts` (`ExtensionAPI.registerShortcut`). The installed `docs/keybindings.md`, “Models and Thinking” table, assigns `shift+tab` to `app.thinking.cycle`. Choose **`alt+m`**: the installed keybindings reference contains no default `alt+m` binding. **UNVERIFIED:** a user's custom keybindings may still conflict.

### (c) Injecting a user message

```ts
sendUserMessage(
  content: string | (TextContent | ImageContent)[],
  options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean }
): void;
```

Sources: installed `docs/extensions.md`, “ExtensionAPI Methods” → `pi.sendUserMessage(content, options?)`; exact declaration in `dist/core/extensions/types.d.ts`; usage in `examples/extensions/send-user-message.ts`. The example confirms direct sending while idle and `deliverAs` for a streaming agent.

### (d) `ctx.hasUI` in each run mode

```ts
hasUI: boolean;
```

Sources: installed `docs/extensions.md`, “ExtensionContext” → `ctx.hasUI` and “Mode Behavior”; exact property in `dist/core/extensions/types.d.ts` (`ExtensionContext`). Documented values: TUI `true`, RPC `true`, JSON `false`, print (`-p`) `false`.

### (e) Reading a CLI flag at `session_start`

```ts
registerFlag(name: string, options:
  | { description?: string; type: "boolean"; default?: boolean }
  | { description?: string; type: "string"; default?: string }
): void;
getFlag(name: string): boolean | string | undefined;
on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): () => void;
```

Sources: installed `docs/extensions.md`, “ExtensionAPI Methods” → `pi.registerFlag(name, options)` (including its `session_start` example); exact signatures in `dist/core/extensions/types.d.ts`; `examples/extensions/plan-mode/index.ts` also reads `pi.getFlag("plan")` during `session_start`. **UNVERIFIED:** the docs' session-start example reads a boolean flag, not a string-valued `permission-mode` flag, and do not show the resulting `--permission-mode` spelling. The string type is present in the installed declaration; applying the same session-start read to it is an inference.

## Spec items requiring a conservative alternative

- Pi does not expose a verified, definitive `writeCapable` property for arbitrary extension/MCP tools. Annotations are explicitly hints only. In plan mode, hide all tools that are not in the known read-only set and deny unrecognized calls in the hook. This is stricter than hiding only unknown write-capable tools.
- `agent_end` can be followed by retries or queued work; use the documented final `agent_settled` event for plan approval instead.
- All other Step 0 APIs requested by the plan are present in Pi 1.5.2, including string CLI flags, session persistence, active-tool management, UI dialogs/status, prompt modification, and configured-provider model calls.
