import assert from "node:assert/strict";
import test from "node:test";
import { CYCLE_MODES, formatModeList, MODE_INFO, nextCycleMode, PERMISSION_MODES } from "../modes.ts";

test("available modes include plan and gated bypass", () => {
  assert.deepEqual(PERMISSION_MODES, ["default", "acceptEdits", "plan", "bypassPermissions"]);
  assert.equal(MODE_INFO.default.badge, "● manual");
  assert.equal(MODE_INFO.acceptEdits.badge, "✎ edits");
  assert.equal(MODE_INFO.bypassPermissions.badge, "⚡ bypass");
  assert.deepEqual(CYCLE_MODES, ["default", "acceptEdits", "plan"]);
  assert.equal(MODE_INFO.plan.badge, "⏸ plan");
});

test("keyboard cycle omits bypass and includes plan", () => {
  assert.equal(nextCycleMode("default"), "acceptEdits");
  assert.equal(nextCycleMode("acceptEdits"), "plan");
  assert.equal(nextCycleMode("plan"), "default");
  assert.equal(nextCycleMode("bypassPermissions"), "default");
  assert.match(formatModeList("acceptEdits"), /› ✎ edits acceptEdits/);
});
