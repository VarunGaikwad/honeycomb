import assert from "node:assert/strict";
import test from "node:test";
import { MODE_ENTRY_TYPE, persistMode, resolveInitialMode, restoreMode, restorePlanTools } from "../state.ts";

test("restoreMode uses the latest permission-mode entry on the active branch", () => {
  const entries = [
    { type: "custom", customType: MODE_ENTRY_TYPE, data: { mode: "default" } },
    { type: "message", message: {} },
    { type: "custom", customType: MODE_ENTRY_TYPE, data: { mode: "acceptEdits" } },
  ];
  assert.equal(restoreMode(entries), "acceptEdits");
  assert.equal(restoreMode([{ type: "custom", customType: "other", data: { mode: "acceptEdits" } }]), undefined);
  assert.equal(restoreMode([
    { type: "custom", customType: MODE_ENTRY_TYPE, data: { mode: "acceptEdits" } },
    { type: "custom", customType: MODE_ENTRY_TYPE, data: { mode: "auto" } },
  ]), undefined, "a malformed newest mode entry does not resurrect an older mode");
});

test("CLI selection takes precedence over restored state; absent config falls back to default", () => {
  assert.deepEqual(resolveInitialMode("default", "acceptEdits", false), {
    mode: "default", source: "cli", invalidCliMode: false, bypassFallback: false,
  });
  assert.deepEqual(resolveInitialMode(undefined, "acceptEdits", false), {
    mode: "acceptEdits", source: "session", invalidCliMode: false, bypassFallback: false,
  });
  assert.deepEqual(resolveInitialMode(undefined, undefined, false), {
    mode: "default", source: "default", invalidCliMode: false, bypassFallback: false,
  });
  assert.deepEqual(resolveInitialMode("auto", "acceptEdits", false), {
    mode: "default", source: "cli", invalidCliMode: true, bypassFallback: false,
  });
});

test("bypass is restored only for sessions explicitly started with the bypass flag", () => {
  assert.deepEqual(resolveInitialMode(undefined, "bypassPermissions", false), {
    mode: "default", source: "session", invalidCliMode: false, bypassFallback: true,
  });
  assert.deepEqual(resolveInitialMode("bypassPermissions", "acceptEdits", true), {
    mode: "bypassPermissions", source: "cli", invalidCliMode: false, bypassFallback: false,
  });
});

test("plan state validates and restores the exact previous tool snapshot", () => {
  const tools = ["write", "read", "custom"];
  const entries: unknown[] = [];
  persistMode("plan", (customType, data) => entries.push({ type: "custom", customType, data }), tools);
  tools.push("late");
  assert.deepEqual(restorePlanTools(entries), ["write", "read", "custom"]);
  assert.equal(restorePlanTools([{ type: "custom", customType: MODE_ENTRY_TYPE, data: { mode: "plan", previousTools: ["read", 3] } }]), undefined);
  assert.equal(restorePlanTools([{ type: "custom", customType: MODE_ENTRY_TYPE, data: { mode: "default", previousTools: ["read"] } }]), undefined);
});

test("persistMode stores the mode in the extension's custom session entry", () => {
  let saved: { customType: string; data: { mode: string } } | undefined;
  persistMode("acceptEdits", (customType, data) => { saved = { customType, data }; });
  assert.deepEqual(saved, { customType: MODE_ENTRY_TYPE, data: { mode: "acceptEdits" } });
});
