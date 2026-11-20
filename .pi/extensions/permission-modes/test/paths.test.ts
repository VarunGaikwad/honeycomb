import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isInsideCwd, isProtected, resolveReal } from "../paths.ts";

type TestContext = Parameters<NonNullable<Parameters<typeof test>[0]>>[0];

function tempDirectory(t: TestContext): string {
  const root = mkdtempSync(path.join(tmpdir(), "permission-modes-paths-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("resolveReal resolves existing and missing paths through the nearest real parent", (t) => {
  const root = tempDirectory(t);
  const project = path.join(root, "project");
  mkdirSync(path.join(project, "src"), { recursive: true });
  writeFileSync(path.join(project, "src", "a.ts"), "ok");

  assert.equal(resolveReal("src/a.ts", project), realpathSync(path.join(project, "src", "a.ts")));
  assert.equal(resolveReal("src/new/file.ts", project), path.join(realpathSync(path.join(project, "src")), "new", "file.ts"));
  assert.equal(resolveReal("~/new-file", project), path.join(realpathSync(homedir()), "new-file"));
});

test("resolveReal follows directory symlinks before appending missing components", (t) => {
  const root = tempDirectory(t);
  const project = path.join(root, "project");
  const outside = path.join(root, "outside");
  mkdirSync(project);
  mkdirSync(outside);
  symlinkSync(outside, path.join(project, "link"), "dir");

  assert.equal(resolveReal("link/missing.txt", project), path.join(realpathSync(outside), "missing.txt"));
  assert.equal(isInsideCwd("link/missing.txt", project), false);
});

test("dangling symlinks to outside paths are resolved rather than treated as in-cwd", (t) => {
  const root = tempDirectory(t);
  const project = path.join(root, "project");
  const outside = path.join(root, "outside");
  mkdirSync(project);
  symlinkSync(path.join(outside, "not-created"), path.join(project, "dangling"));

  assert.equal(resolveReal("dangling/child.txt", project), path.join(realpathSync(root), "outside", "not-created", "child.txt"));
  assert.equal(isInsideCwd("dangling/child.txt", project), false);
});

test("isInsideCwd uses a separator boundary, not a string prefix", (t) => {
  const root = tempDirectory(t);
  const project = path.join(root, "project");
  const sibling = path.join(root, "project-evil");
  mkdirSync(project);
  mkdirSync(sibling);

  assert.equal(isInsideCwd("src/file.ts", project), true);
  assert.equal(isInsideCwd(project, project), true);
  assert.equal(isInsideCwd(sibling, project), false);
  assert.equal(isInsideCwd("../project-evil/file.ts", project), false);
});

test("isInsideCwd denies symlink escapes for existing and not-yet-created files", (t) => {
  const root = tempDirectory(t);
  const project = path.join(root, "project");
  const outside = path.join(root, "outside");
  mkdirSync(project);
  mkdirSync(outside);
  writeFileSync(path.join(outside, "existing.ts"), "outside");
  symlinkSync(outside, path.join(project, "link"), "dir");

  assert.equal(isInsideCwd("link/existing.ts", project), false);
  assert.equal(isInsideCwd("link/new.ts", project), false);
});

test("isProtected recognizes sensitive basenames and directory internals", (t) => {
  const root = tempDirectory(t);
  const cwd = path.join(root, "project");
  mkdirSync(cwd);

  for (const file of [
    ".env", ".env.local", "server.pem", "private.key", "id_rsa", "id_rsa.pub",
    ".git/config", "node_modules/pkg/file.js",
  ]) assert.equal(isProtected(file, cwd), true, file);

  for (const file of [".envx", ".gitignore", "src/key.ts", "private.pemx", "readme.md"]) {
    assert.equal(isProtected(file, cwd), false, file);
  }
});

test("isProtected includes home SSH/Pi directories and shell rc files", (t) => {
  const root = tempDirectory(t);
  const cwd = path.join(root, "project");
  mkdirSync(cwd);

  for (const file of [
    path.join(homedir(), ".ssh", "id_ed25519"),
    path.join(homedir(), ".pi", "agent", "settings.json"),
    path.join(homedir(), ".bashrc"),
    path.join(homedir(), ".zshrc"),
    path.join(homedir(), ".profile"),
  ]) assert.equal(isProtected(file, cwd), true, file);
});

test("isProtected follows aliases into protected paths", (t) => {
  const root = tempDirectory(t);
  const cwd = path.join(root, "project");
  mkdirSync(cwd);
  writeFileSync(path.join(cwd, ".env"), "secret");
  symlinkSync(path.join(cwd, ".env"), path.join(cwd, "secret-alias"));

  assert.equal(isProtected("secret-alias", cwd), true);
});
