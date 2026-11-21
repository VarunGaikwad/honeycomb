import { mkdtempSync, readFileSync, symlinkSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import registerPermissionModes, { createToolCallHandler } from "../index.ts";
import type { Verdict } from "../policy.ts";

interface TestContext {
  cwd: string;
  hasUI: boolean;
  ui: {
    select(title: string, options: string[]): Promise<string | undefined>;
    confirm(title: string, message: string): Promise<boolean>;
    notify(message: string, type?: "info" | "warning" | "error"): void;
    setStatus(key: string, text: string | undefined): void;
  };
  sessionManager: { getBranch(): unknown[] };
}

function makeContext(options: {
  cwd?: string;
  hasUI?: boolean;
  select?: (title: string, options: string[]) => Promise<string | undefined> | string | undefined;
  confirm?: (title: string, message: string) => Promise<boolean> | boolean;
  entries?: unknown[];
  onStatus?: (key: string, text: string | undefined) => void;
  onNotify?: (message: string, type?: "info" | "warning" | "error") => void;
} = {}): TestContext {
  return {
    cwd: options.cwd ?? process.cwd(),
    hasUI: options.hasUI ?? true,
    ui: {
      select: async (title, choices) => await options.select?.(title, choices),
      confirm: async (title, message) => await (options.confirm?.(title, message) ?? false),
      notify: (message, type) => options.onNotify?.(message, type),
      setStatus: (key, text) => options.onStatus?.(key, text),
    },
    sessionManager: { getBranch: () => options.entries ?? [] },
  };
}

function verdict(action: Verdict["action"], reason = "Test policy verdict."): Verdict {
  return { action, reason, source: "mode" };
}

test("tool-call adapter fails closed when the policy throws", async () => {
  const handler = createToolCallHandler({
    getMode: () => "default",
    isBypassEnabled: () => false,
    policy: () => { throw new Error("unexpected"); },
  });
  const result = await handler.handle({ toolName: "bash", input: { command: "ls" } }, makeContext());
  assert.deepEqual(result, { block: true, reason: "Permission policy failed; tool call blocked." });
});

test("malformed tool input is denied before policy evaluation", async () => {
  let evaluated = false;
  const handler = createToolCallHandler({
    getMode: () => "default",
    isBypassEnabled: () => false,
    policy: () => {
      evaluated = true;
      return verdict("allow");
    },
  });
  const result = await handler.handle({ toolName: "extension_tool", input: null }, makeContext());
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /not a record/);
  assert.equal(evaluated, false);
});

test("ask decisions require UI and use the exact three approval options", async () => {
  let receivedOptions: string[] = [];
  const handler = createToolCallHandler({
    getMode: () => "default",
    isBypassEnabled: () => false,
    policy: () => verdict("ask", "Needs user approval."),
  });
  const call = { toolName: "extension_tool", input: { action: "run" } };
  const noUi = await handler.handle(call, makeContext({ hasUI: false }));
  assert.equal(noUi?.block, true);
  assert.match(noUi?.reason ?? "", /no interactive UI/);

  const denied = await handler.handle(call, makeContext({
    select: (_title, options) => {
      receivedOptions = options;
      return "Deny";
    },
  }));
  assert.deepEqual(receivedOptions, ["Allow once", "Allow for this session", "Deny"]);
  assert.equal(denied?.block, true);
  assert.match(denied?.reason ?? "", /denied/);
});

test("session approval matches only an exact tool and normalized input, then resets", async () => {
  let selectionCount = 0;
  const handler = createToolCallHandler({
    getMode: () => "default",
    isBypassEnabled: () => false,
    policy: () => verdict("ask"),
  });
  const ctx = makeContext({
    select: () => {
      selectionCount++;
      return selectionCount === 1 ? "Allow for this session" : "Deny";
    },
  });

  assert.equal(await handler.handle({ toolName: "bash", input: { command: "npm   test" } }, ctx), undefined);
  assert.equal(await handler.handle({ toolName: "bash", input: { command: "npm test" } }, ctx), undefined,
    "whitespace-normalized bash command gets the exact stored grant");
  assert.equal(selectionCount, 1);

  assert.equal((await handler.handle({ toolName: "bash", input: { command: "npm test --" } }, ctx))?.block, true);
  assert.equal((await handler.handle({ toolName: "other", input: { command: "npm test" } }, ctx))?.block, true);
  assert.equal(selectionCount, 3, "changed input and changed tool name must prompt again");

  handler.clearSessionApprovals();
  assert.equal((await handler.handle({ toolName: "bash", input: { command: "npm test" } }, ctx))?.block, true);
  assert.equal(selectionCount, 4, "session grants do not survive a session reset");
});

test("Allow once does not create a session grant and policy deny cannot be overridden", async () => {
  let prompts = 0;
  const handler = createToolCallHandler({
    getMode: () => "default",
    isBypassEnabled: () => false,
    policy: (_mode, call) => call.toolName === "denied" ? verdict("deny", "Hard deny.") : verdict("ask"),
  });
  const ctx = makeContext({
    select: () => {
      prompts++;
      return "Allow once";
    },
  });
  const event = { toolName: "ask", input: { action: "one" } };
  assert.equal(await handler.handle(event, ctx), undefined);
  assert.equal(await handler.handle(event, ctx), undefined);
  assert.equal(prompts, 2);
  assert.match((await handler.handle({ toolName: "denied", input: {} }, ctx))?.reason ?? "", /Hard deny/);
  assert.equal(prompts, 2);
});

interface FakePi {
  registerTool(tool: unknown): void;
  registerFlag(name: string, options: unknown): void;
  getFlag(name: string): string | boolean | undefined;
  appendEntry(customType: string, data?: unknown): void;
  on(event: string, handler: unknown): () => void;
  registerCommand(name: string, options: unknown): void;
  registerShortcut(shortcut: string, options: unknown): void;
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
  getAllTools(): Array<{ name: string; sourceInfo: { source: string; path: string } }>;
  sendUserMessage(content: string): void;
}

function makeFakePi() {
  let flag: string | undefined;
  let activeTools = ["read", "bash", "edit", "write", "custom", "grep", "find", "ls"];
  const sentMessages: string[] = [];
  const allTools = activeTools.map((name) => ({
    name, sourceInfo: { source: name === "custom" ? "extension" : "builtin", path: `builtin:${name}` },
  }));
  const entries: unknown[] = [];
  const statuses = new Map<string, string | undefined>();
  const notifications: string[] = [];
  const eventHandlers = new Map<string, (...args: unknown[]) => unknown>();
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const commandOptions = new Map<string, unknown>();
  const shortcuts = new Map<string, unknown>();
  const registeredFlags: Array<{ name: string; options: unknown }> = [];
  const tools: unknown[] = [];
  const api: FakePi = {
    registerTool: (tool) => { tools.push(tool); },
    registerFlag: (name, options) => registeredFlags.push({ name, options }),
    getFlag: () => flag,
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    on: (event, handler) => {
      eventHandlers.set(event, handler as (...args: unknown[]) => unknown);
      return () => undefined;
    },
    registerCommand: (name, options) => {
      commandOptions.set(name, options);
      commands.set(name, (options as { handler: (...args: unknown[]) => unknown }).handler);
    },
    registerShortcut: (shortcut, options) => shortcuts.set(shortcut, options),
    getActiveTools: () => [...activeTools],
    setActiveTools: (names) => { activeTools = [...names]; },
    getAllTools: () => allTools,
    sendUserMessage: (content) => { sentMessages.push(content); },
  };
  return {
    api,
    tools,
    entries,
    statuses,
    notifications,
    eventHandlers,
    commands,
    commandOptions,
    shortcuts,
    registeredFlags,
    allTools,
    sentMessages,
    setFlag: (value: string | undefined) => { flag = value; },
  };
}

async function callHandler(
  handlers: Map<string, (...args: unknown[]) => unknown>,
  eventName: string,
  event: unknown,
  ctx: TestContext,
): Promise<unknown> {
  const handler = handlers.get(eventName);
  assert.ok(handler, `registered ${eventName} handler`);
  return await handler(event, ctx);
}

async function callCommand(
  commands: Map<string, (...args: unknown[]) => unknown>,
  name: string,
  args: string,
  ctx: TestContext,
): Promise<void> {
  const handler = commands.get(name);
  assert.ok(handler, `registered /${name} command`);
  await handler(args, ctx);
}

test("extension registers the CLI flag, mode command, alt+m cycle, and persistent status", async () => {
  const fake = makeFakePi();
  registerPermissionModes(fake.api as unknown as Parameters<typeof registerPermissionModes>[0]);
  assert.equal(fake.registeredFlags[0]?.name, "permission-mode");
  assert.ok(fake.commands.has("mode"));
  assert.ok(fake.shortcuts.has("alt+m"));
  const complete = (fake.commandOptions.get("mode") as {
    getArgumentCompletions(prefix: string): Array<{ value: string; description?: string }>;
  }).getArgumentCompletions;
  assert.deepEqual(complete("accept").map(({ value }) => value), ["acceptEdits"]);
  assert.match(complete("bypass")[0]?.description ?? "", /Requires --permission-mode/);

  const ctx = makeContext({
    entries: fake.entries,
    onStatus: (key, text) => fake.statuses.set(key, text),
    onNotify: (message) => fake.notifications.push(message),
  });
  await callHandler(fake.eventHandlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
  assert.equal(fake.statuses.get("permission-modes"), "● manual");

  await callCommand(fake.commands, "mode", "acceptEdits", ctx);
  assert.equal(fake.statuses.get("permission-modes"), "✎ edits");
  assert.equal(fake.entries.length, 1);

  fake.setFlag(undefined);
  await callHandler(fake.eventHandlers, "session_start", { type: "session_start", reason: "resume" }, ctx);
  assert.equal(fake.statuses.get("permission-modes"), "✎ edits", "latest session entry is restored");

  fake.setFlag("default");
  await callHandler(fake.eventHandlers, "session_start", { type: "session_start", reason: "resume" }, ctx);
  assert.equal(fake.statuses.get("permission-modes"), "● manual", "CLI selection overrides the session entry");

  const cycle = fake.shortcuts.get("alt+m") as { handler: (ctx: TestContext) => Promise<void> };
  await cycle.handler(ctx);
  assert.equal(fake.statuses.get("permission-modes"), "✎ edits");
});

test("bypass requires the startup flag and an interactive confirmation to switch into it", async () => {
  const fake = makeFakePi();
  registerPermissionModes(fake.api as unknown as Parameters<typeof registerPermissionModes>[0]);
  let confirmations = 0;
  let confirmed = true;
  const ctx = makeContext({
    entries: fake.entries,
    confirm: () => {
      confirmations++;
      return confirmed;
    },
    onStatus: (key, text) => fake.statuses.set(key, text),
    onNotify: (message) => fake.notifications.push(message),
  });
  await callHandler(fake.eventHandlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
  await callCommand(fake.commands, "mode", "bypassPermissions", ctx);
  assert.equal(confirmations, 0);
  assert.equal(fake.statuses.get("permission-modes"), "● manual");

  fake.setFlag("acceptEdits");
  await callHandler(fake.eventHandlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
  await callCommand(fake.commands, "mode", "bypassPermissions", ctx);
  assert.equal(confirmations, 0, "a non-bypass CLI mode does not enable bypass switching");
  assert.equal(fake.statuses.get("permission-modes"), "✎ edits");

  fake.setFlag("bypassPermissions");
  await callHandler(fake.eventHandlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
  assert.equal(fake.statuses.get("permission-modes"), "⚡ bypass", "explicit startup flag enables bypass mode");
  await callCommand(fake.commands, "mode", "default", ctx);
  await callCommand(fake.commands, "mode", "bypassPermissions", ctx);
  assert.equal(confirmations, 1);
  assert.equal(fake.statuses.get("permission-modes"), "⚡ bypass");

  confirmed = false;
  await callCommand(fake.commands, "mode", "default", ctx);
  await callCommand(fake.commands, "mode", "bypassPermissions", ctx);
  assert.equal(confirmations, 2);
  assert.equal(fake.statuses.get("permission-modes"), "● manual", "cancelled confirmation leaves the mode unchanged");
});

test("plan mode filters and restores exact tools, injects instructions, and blocks unsafe calls", async () => {
  const fake = makeFakePi();
  registerPermissionModes(fake.api as unknown as Parameters<typeof registerPermissionModes>[0]);
  const ctx = makeContext({ entries: fake.entries, onStatus: (key, text) => fake.statuses.set(key, text) });
  await callHandler(fake.eventHandlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
  const before = fake.api.getActiveTools();
  await callCommand(fake.commands, "mode", "plan", ctx);
  assert.equal(fake.statuses.get("permission-modes"), "⏸ plan");
  assert.deepEqual(fake.api.getActiveTools(), ["read", "grep", "find", "ls", "save_plan"]);
  const prompt = await callHandler(fake.eventHandlers, "before_agent_start", { systemPrompt: "base" }, ctx) as { systemPrompt: string };
  assert.match(prompt.systemPrompt, /PLAN mode/);
  assert.match(prompt.systemPrompt, /Use save_plan/);
  for (const toolName of ["bash", "write", "edit", "custom", "powershell"]) {
    const blocked = await callHandler(fake.eventHandlers, "tool_call", { toolName, input: { command: "git status", path: "a.ts" } }, ctx) as { block: boolean };
    assert.equal(blocked.block, true, toolName);
  }
  assert.equal(await callHandler(fake.eventHandlers, "tool_call", { toolName: "read", input: { path: "a.ts" } }, ctx), undefined);
  await callCommand(fake.commands, "mode", "default", ctx);
  assert.deepEqual(fake.api.getActiveTools(), before);
  assert.equal(await callHandler(fake.eventHandlers, "before_agent_start", { systemPrompt: "base" }, ctx), undefined);
});

test("CLI plan mode saves the original tool list for reload and exit", async () => {
  const fake = makeFakePi();
  fake.setFlag("plan");
  registerPermissionModes(fake.api as unknown as Parameters<typeof registerPermissionModes>[0]);
  const ctx = makeContext({ entries: fake.entries });
  const before = fake.api.getActiveTools();
  await callHandler(fake.eventHandlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
  assert.deepEqual(fake.api.getActiveTools(), ["read", "grep", "find", "ls", "save_plan"]);
  await callHandler(fake.eventHandlers, "session_start", { type: "session_start", reason: "reload" }, ctx);
  await callCommand(fake.commands, "mode", "default", ctx);
  assert.deepEqual(fake.api.getActiveTools(), before);
});

test("plan restore keeps the saved full active-tool list across reload", async () => {
  const fake = makeFakePi();
  registerPermissionModes(fake.api as unknown as Parameters<typeof registerPermissionModes>[0]);
  const ctx = makeContext({ entries: fake.entries });
  await callHandler(fake.eventHandlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
  const before = fake.api.getActiveTools();
  await callCommand(fake.commands, "mode", "plan", ctx);
  await callHandler(fake.eventHandlers, "session_start", { type: "session_start", reason: "reload" }, ctx);
  assert.deepEqual(fake.api.getActiveTools(), ["read", "grep", "find", "ls", "save_plan"]);
  await callCommand(fake.commands, "mode", "acceptEdits", ctx);
  assert.deepEqual(fake.api.getActiveTools(), before);
});

test("plan mode rejects tools masquerading as trusted read built-ins", async () => {
  const fake = makeFakePi();
  fake.allTools.find((tool) => tool.name === "read")!.sourceInfo.source = "extension";
  registerPermissionModes(fake.api as unknown as Parameters<typeof registerPermissionModes>[0]);
  const ctx = makeContext({ entries: fake.entries });
  await callHandler(fake.eventHandlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
  await callCommand(fake.commands, "mode", "plan", ctx);
  assert.ok(!fake.api.getActiveTools().includes("read"));
  const blocked = await callHandler(fake.eventHandlers, "tool_call", { toolName: "read", input: { path: "a.ts" } }, ctx) as { block: boolean };
  assert.equal(blocked.block, true);
});

test("a stale settled-dialog discard cannot change a later plan session", async () => {
  const fake = makeFakePi();
  registerPermissionModes(fake.api as unknown as Parameters<typeof registerPermissionModes>[0]);
  let finish!: (value: string | undefined) => void;
  const ctx = makeContext({ entries: fake.entries, onStatus: (key, text) => fake.statuses.set(key, text),
    select: () => new Promise((resolve) => { finish = resolve; }) });
  await callHandler(fake.eventHandlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
  await callCommand(fake.commands, "mode", "plan", ctx);
  const pending = callHandler(fake.eventHandlers, "agent_settled", { type: "agent_settled", aborted: false }, ctx);
  await callCommand(fake.commands, "mode", "default", ctx);
  await callCommand(fake.commands, "mode", "plan", ctx);
  finish("Discard");
  await pending;
  assert.equal(fake.statuses.get("permission-modes"), "⏸ plan");
  assert.deepEqual(fake.sentMessages, []);
});

test("plan approval decisions never start implementation without secure storage", async () => {
  const fake = makeFakePi();
  registerPermissionModes(fake.api as unknown as Parameters<typeof registerPermissionModes>[0]);
  let selection: string | undefined;
  let prompts = 0;
  const ctx = makeContext({ entries: fake.entries, onStatus: (key, text) => fake.statuses.set(key, text),
    onNotify: (message) => fake.notifications.push(message), select: () => { prompts++; return selection; } });
  await callHandler(fake.eventHandlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
  await callCommand(fake.commands, "mode", "plan", ctx);
  for (selection of ["Approve → switch to acceptEdits and start", "Approve → switch to default", "Keep planning", undefined]) {
    await callHandler(fake.eventHandlers, "agent_settled", { type: "agent_settled", aborted: false }, ctx);
    assert.equal(fake.statuses.get("permission-modes"), "⏸ plan");
    assert.deepEqual(fake.sentMessages, []);
  }
  assert.ok(fake.notifications.some((message) => message.includes("saved plan is required")));
  const noUI = makeContext({ hasUI: false, entries: fake.entries, select: () => { throw new Error("must not prompt"); } });
  await callHandler(fake.eventHandlers, "agent_settled", { type: "agent_settled", aborted: false }, noUI);
  await callHandler(fake.eventHandlers, "agent_settled", { type: "agent_settled", aborted: true }, ctx);
  assert.equal(prompts, 4);
  selection = "Discard";
  await callHandler(fake.eventHandlers, "agent_settled", { type: "agent_settled", aborted: false }, ctx);
  assert.equal(fake.statuses.get("permission-modes"), "● manual");
  assert.deepEqual(fake.api.getActiveTools(), ["read", "bash", "edit", "write", "custom", "grep", "find", "ls"]);
  assert.deepEqual(fake.sentMessages, []);
});

test("extension tool-call hook asks in the UI and blocks a denial", async () => {
  const fake = makeFakePi();
  registerPermissionModes(fake.api as unknown as Parameters<typeof registerPermissionModes>[0]);
  await callHandler(fake.eventHandlers, "session_start", { type: "session_start", reason: "startup" }, makeContext());
  let selection = "Deny";
  let options: string[] = [];
  const ctx = makeContext({
    select: (_title, choices) => {
      options = choices;
      return selection;
    },
  });
  const event = { type: "tool_call", toolCallId: "1", toolName: "edit", input: { path: "a.ts", edits: [] } };
  const denied = await callHandler(fake.eventHandlers, "tool_call", event, ctx) as { block: boolean; reason: string };
  assert.deepEqual(options, ["Allow once", "Allow for this session", "Deny"]);
  assert.equal(denied.block, true);
  assert.match(denied.reason, /user|cancelled/i);

  selection = "Allow once";
  assert.equal(await callHandler(fake.eventHandlers, "tool_call", event, ctx), undefined);
});


test("save_plan enforces mode, content-only input, revisions and symlink safety", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "permission-plan-"));
  try {
    const fake = makeFakePi();
    registerPermissionModes(fake.api as unknown as Parameters<typeof registerPermissionModes>[0]);
    const tool = fake.tools[0] as { execute(id: string, args: unknown, signal: AbortSignal | undefined, update: undefined, ctx: TestContext): Promise<{ details: { path: string } }> };
    const ctx = makeContext({ cwd: dir, entries: fake.entries });
    await callHandler(fake.eventHandlers, "session_start", {}, ctx);
    await assert.rejects(tool.execute("1", { content: "no" }, undefined, undefined, ctx));
    await callCommand(fake.commands, "mode", "plan", ctx);
    await assert.rejects(tool.execute("1", { content: "no", path: "../../escape" }, undefined, undefined, ctx));
    const first = await tool.execute("1", { content: "first" }, undefined, undefined, ctx);
    const second = await tool.execute("2", { content: "second" }, undefined, undefined, ctx);
    assert.notEqual(first.details.path, second.details.path);
    assert.equal(readFileSync(first.details.path, "utf8"), "first");
    assert.equal(readFileSync(second.details.path, "utf8"), "second");
    assert.equal(path.dirname(first.details.path), path.join(dir, ".pi", "plans"));
    const abort = new AbortController(); abort.abort();
    await assert.rejects(tool.execute("3", { content: "abort" }, abort.signal, undefined, ctx));
    const other = mkdtempSync(path.join(tmpdir(), "permission-link-"));
    try {
      mkdirSync(path.join(other, ".pi"));
      symlinkSync(path.join(dir, ".pi", "plans"), path.join(other, ".pi", "plans"));
      await assert.rejects(tool.execute("4", { content: "bad" }, undefined, undefined, makeContext({ cwd: other })));
    } finally { rmSync(other, { recursive: true, force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("saved plans require explicit approval and hand off exactly once in each mode", async () => {
  for (const [choice, badge] of [["Approve → switch to acceptEdits and start", "✎ edits"], ["Approve → switch to default", "● manual"]]) {
    const dir = mkdtempSync(path.join(tmpdir(), "plan-approval-"));
    try {
      const fake = makeFakePi();
      registerPermissionModes(fake.api as unknown as Parameters<typeof registerPermissionModes>[0]);
      let selection = "Keep planning";
      const ctx = makeContext({ cwd: dir, entries: fake.entries, select: () => selection, onStatus: (k, v) => fake.statuses.set(k, v) });
      await callHandler(fake.eventHandlers, "session_start", {}, ctx);
      const original = fake.api.getActiveTools();
      await callCommand(fake.commands, "mode", "plan", ctx);
      const tool = fake.tools[0] as { execute(id: string, args: unknown, signal: undefined, update: undefined, ctx: TestContext): Promise<unknown> };
      await tool.execute("1", { content: "1. implement feature" }, undefined, undefined, ctx);
      await callHandler(fake.eventHandlers, "agent_settled", { aborted: false }, ctx);
      assert.deepEqual(fake.sentMessages, []);
      selection = choice!;
      await Promise.all([callHandler(fake.eventHandlers, "agent_settled", { aborted: false }, ctx), callHandler(fake.eventHandlers, "agent_settled", { aborted: false }, ctx)]);
      assert.equal(fake.statuses.get("permission-modes"), badge);
      assert.deepEqual(fake.api.getActiveTools(), original);
      assert.deepEqual(fake.sentMessages, ["Implement the following approved plan:\n\n1. implement feature"]);
      await callHandler(fake.eventHandlers, "agent_settled", { aborted: false }, ctx);
      assert.equal(fake.sentMessages.length, 1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("mode change after approval transition but before handoff cancels the stale handoff", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "plan-transition-race-"));
  try {
    const fake = makeFakePi(); registerPermissionModes(fake.api as unknown as Parameters<typeof registerPermissionModes>[0]);
    const ctx = makeContext({ cwd: dir, entries: fake.entries, select: () => "Approve → switch to acceptEdits and start",
      onStatus: (key, value) => fake.statuses.set(key, value) });
    await callHandler(fake.eventHandlers, "session_start", {}, ctx); await callCommand(fake.commands, "mode", "plan", ctx);
    const tool = fake.tools[0] as { execute(id: string, args: unknown, signal: undefined, update: undefined, ctx: TestContext): Promise<unknown> };
    await tool.execute("1", { content: "approved plan" }, undefined, undefined, ctx);
    const approval = callHandler(fake.eventHandlers, "agent_settled", { aborted: false }, ctx);
    await callCommand(fake.commands, "mode", "default", ctx);
    await approval;
    assert.deepEqual(fake.sentMessages, []);
    assert.equal(fake.statuses.get("permission-modes"), "● manual");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("revision change during approval rejects stale dialog", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "plan-stale-"));
  try {
    const fake = makeFakePi(); registerPermissionModes(fake.api as unknown as Parameters<typeof registerPermissionModes>[0]);
    let finish!: (value: string) => void;
    const ctx = makeContext({ cwd: dir, entries: fake.entries, select: () => new Promise(resolve => { finish = resolve; }) });
    await callHandler(fake.eventHandlers, "session_start", {}, ctx); await callCommand(fake.commands, "mode", "plan", ctx);
    const tool = fake.tools[0] as { execute(id: string, args: unknown, signal: undefined, update: undefined, ctx: TestContext): Promise<unknown> };
    await tool.execute("1", { content: "A" }, undefined, undefined, ctx);
    const pending = callHandler(fake.eventHandlers, "agent_settled", { aborted: false }, ctx);
    await tool.execute("2", { content: "B" }, undefined, undefined, ctx);
    finish("Approve → switch to default"); await pending;
    assert.deepEqual(fake.sentMessages, []);
    assert.ok(fake.api.getActiveTools().includes("save_plan"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("missing saved file and send failure cannot trigger duplicate handoffs", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "plan-error-"));
  try {
    const fake = makeFakePi(); let attempts = 0;
    fake.api.sendUserMessage = () => { attempts++; throw new Error("send failed"); };
    registerPermissionModes(fake.api as unknown as Parameters<typeof registerPermissionModes>[0]);
    const ctx = makeContext({ cwd: dir, entries: fake.entries, select: () => "Approve → switch to default", onNotify: message => fake.notifications.push(message) });
    await callHandler(fake.eventHandlers, "session_start", {}, ctx); await callCommand(fake.commands, "mode", "plan", ctx);
    const tool = fake.tools[0] as { execute(id: string, args: unknown, signal: undefined, update: undefined, ctx: TestContext): Promise<{ details: { path: string } }> };
    const saved = await tool.execute("1", { content: "first" }, undefined, undefined, ctx);
    rmSync(saved.details.path);
    await callHandler(fake.eventHandlers, "agent_settled", { aborted: false }, ctx);
    assert.equal(attempts, 0);
    assert.ok(fake.notifications.some(message => message.includes("missing or invalid")));
    await tool.execute("2", { content: "second" }, undefined, undefined, ctx);
    await callHandler(fake.eventHandlers, "agent_settled", { aborted: false }, ctx);
    await callHandler(fake.eventHandlers, "agent_settled", { aborted: false }, ctx);
    assert.equal(attempts, 1);
    assert.ok(fake.notifications.some(message => message.includes("handoff failed")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
