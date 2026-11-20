import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { cwdRelativePath, matchRules, matchesRule, normalizeBashCommand, type Rules } from "../rules.ts";

type TestContext = Parameters<NonNullable<Parameters<typeof test>[0]>>[0];

function tempDirectory(t: TestContext): string {
  const root = mkdtempSync(path.join(tmpdir(), "permission-modes-rules-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("bash rules compare full normalized commands", () => {
  const call = { toolName: "bash", input: { command: "  npm   test  " } };
  assert.equal(matchesRule(call, "bash:npm test", "/project"), true);
  assert.equal(matchesRule(call, "bash:npm run test", "/project"), false);
  assert.equal(matchesRule({ toolName: "bash", input: { command: 'echo "a  b"' } }, 'bash:echo "a  b"'), true);
  assert.equal(normalizeBashCommand("  git   status "), "git status");
});

test("bash wildcard is allowed only as a single trailing star", () => {
  const call = { toolName: "bash", input: { command: "npm test --watch" } };
  assert.equal(matchesRule(call, "bash:npm test*"), true);
  assert.equal(matchesRule(call, "bash:npm*"), true);
  assert.equal(matchesRule(call, "bash:npm*test"), false);
  assert.equal(matchesRule(call, "bash:npm**"), false);
  assert.equal(matchesRule(call, "bash:npm test"), false);
});

test("file rules match cwd-relative paths with *, **, and ?", (t) => {
  const cwd = tempDirectory(t);
  const call = { toolName: "edit", input: { path: "src/deep/a1.ts" } };

  assert.equal(matchesRule(call, "edit:src/**/*.ts", cwd), true);
  assert.equal(matchesRule(call, "edit:src/**/a?.ts", cwd), true);
  assert.equal(matchesRule(call, "edit:src/*.ts", cwd), false);
  assert.equal(matchesRule(call, "write:src/**/*.ts", cwd), false);
  assert.equal(matchesRule({ toolName: "edit", input: { path: path.join(cwd, "src/deep/a1.ts") } }, "edit:src/**/*.ts", cwd), true);
});

test("file paths normalize separators and keep outside paths relative to cwd", (t) => {
  const cwd = tempDirectory(t);
  assert.equal(cwdRelativePath("src\\nested\\file.ts", cwd), "src/nested/file.ts");
  assert.equal(cwdRelativePath("../outside.ts", cwd), "../outside.ts");
  assert.equal(matchesRule({ toolName: "write", input: { path: "src\\file.ts" } }, "write:src/*.ts", cwd), true);
  assert.equal(matchesRule({ toolName: "write", input: { path: "../outside.ts" } }, "write:*.ts", cwd), false);
});

test("invalid rules and calls fail to match", () => {
  assert.equal(matchesRule({ toolName: "edit", input: { path: "x" } }, "edit"), false);
  assert.equal(matchesRule({ toolName: "edit", input: {} }, "edit:*"), false);
  assert.equal(matchesRule({ toolName: "bash", input: { command: 3 } }, "bash:*"), false);
  assert.equal(matchesRule({ toolName: "edit", input: { path: "x" } }, "edit:"), false);
});

test("deny, ask, and allow rule sets are matched in security order", (t) => {
  const cwd = tempDirectory(t);
  const call = { toolName: "bash", input: { command: "git push origin main" } };
  const rules: Rules = {
    allow: ["bash:git push*"],
    ask: ["bash:git push*"],
    deny: ["bash:git push origin*"],
  };
  assert.equal(matchRules(call, rules, cwd), "deny");

  assert.equal(matchRules(call, { allow: ["bash:git push*"], ask: ["bash:git push*"] }, cwd), "ask");
  assert.equal(matchRules(call, { allow: ["bash:git push*"] }, cwd), "allow");
  assert.equal(matchRules(call, {}, cwd), undefined);
});
