import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PlanStore, savePlan } from "../plan-storage.ts";

const ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003", "00000000-0000-4000-8000-000000000004"];

test("partial failure and interruption preserve the latest complete revision", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "plan-storage-"));
  let index = 0;
  let fail = false;
  const controller = new AbortController();
  let interrupt = false;
  const store = new PlanStore({ generateId: () => ids[index++]!, write: (fd, content) => {
    writeFileSync(fd, content);
    if (fail) throw new Error("injected write failure");
    if (interrupt) controller.abort();
  } });
  try {
    const first = store.save(cwd, "plan A");
    fail = true;
    assert.throws(() => store.save(cwd, "partial B"), /injected write failure/);
    assert.equal(store.latest, first);
    assert.equal(readFileSync(first, "utf8"), "plan A");
    // A failed file may remain on disk, but it is never the approval candidate.
    assert.notEqual(store.latest, path.join(cwd, ".pi", "plans", `${ids[1]}.md`));
    fail = false; interrupt = true;
    assert.throws(() => store.save(cwd, "interrupted", controller.signal), /aborted/);
    assert.equal(store.latest, first);
    index = 2; interrupt = false;
    // The interrupted file cannot be reused: exclusive creation fails safely.
    assert.throws(() => store.save(cwd, "collision"), { code: "EEXIST" });
    assert.equal(store.latest, first);
    index = 3;
    const next = store.save(cwd, "complete");
    assert.equal(store.latest, next);
    assert.equal(readFileSync(next, "utf8"), "complete");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("collision fails once without overwriting or changing latest, then recovery succeeds", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "plan-collision-"));
  let id = ids[0]!; let calls = 0;
  const store = new PlanStore({ generateId: () => { calls++; return id; } });
  try {
    const first = store.save(cwd, "original");
    assert.throws(() => store.save(cwd, "overwrite"), { code: "EEXIST" });
    assert.equal(calls, 2);
    assert.equal(store.latest, first);
    assert.equal(readFileSync(first, "utf8"), "original");
    id = ids[1]!;
    const next = store.save(cwd, "new");
    assert.equal(store.latest, next);
    assert.equal(readFileSync(next, "utf8"), "new");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("trusted cwd and generated identifier cannot traverse; symlink components rejected", () => {
  const root = mkdtempSync(path.join(tmpdir(), "plan-path-"));
  try {
    const inside = path.join(root, "inside"); const outside = path.join(root, "outside");
    mkdirSync(inside); mkdirSync(outside);
    assert.throws(() => savePlan(`${inside}/../outside`, "x"), /Invalid working directory/);
    assert.throws(() => savePlan(inside, "x", undefined, { generateId: () => "../../outside/escape" }), /Invalid generated plan identifier/);
    rmSync(path.join(inside, ".pi", "plans"), { recursive: true, force: true });
    symlinkSync(outside, path.join(inside, ".pi", "plans"));
    assert.throws(() => savePlan(inside, "x"), /Unsafe plan directory/);
    rmSync(path.join(inside, ".pi"), { recursive: true, force: true });
    symlinkSync(outside, path.join(inside, ".pi"));
    assert.throws(() => savePlan(inside, "x"), /Unsafe plan directory/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
