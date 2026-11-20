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
  registerFlag(name: string, options: unknown): void;
  getFlag(name: string): string | boolean | undefined;
  appendEntry(customType: string, data?: unknown): void;
  on(event: string, handler: unknown): () => void;
  registerCommand(name: string, options: unknown): void;
  registerShortcut(shortcut: string, options: unknown): void;
}

function makeFakePi() {
  let flag: string | undefined;
  const entries: unknown[] = [];
  const statuses = new Map<string, string | undefined>();
  const notifications: string[] = [];
  const eventHandlers = new Map<string, (...args: unknown[]) => unknown>();
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const commandOptions = new Map<string, unknown>();
  const shortcuts = new Map<string, unknown>();
  const registeredFlags: Array<{ name: string; options: unknown }> = [];
  const api: FakePi = {
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
  };
  return {
    api,
    entries,
    statuses,
    notifications,
    eventHandlers,
    commands,
    commandOptions,
    shortcuts,
    registeredFlags,
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
