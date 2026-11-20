import assert from "node:assert/strict";
import test from "node:test";
import { CYCLE_MODES, formatModeList, MODE_INFO, nextCycleMode, PERMISSION_MODES } from "../modes.ts";

test("Milestone 4 exposes only default, acceptEdits, and gated bypass modes", () => {
  assert.deepEqual(PERMISSION_MODES, ["default", "acceptEdits", "bypassPermissions"]);
  assert.equal(MODE_INFO.default.badge, "● manual");
  assert.equal(MODE_INFO.acceptEdits.badge, "✎ edits");
  assert.equal(MODE_INFO.bypassPermissions.badge, "⚡ bypass");
  assert.deepEqual(CYCLE_MODES, ["default", "acceptEdits"]);
});

test("keyboard cycle omits bypass and wraps between manual and edits", () => {
  assert.equal(nextCycleMode("default"), "acceptEdits");
  assert.equal(nextCycleMode("acceptEdits"), "default");
  assert.equal(nextCycleMode("bypassPermissions"), "default");
  assert.match(formatModeList("acceptEdits"), /› ✎ edits acceptEdits/);
});
