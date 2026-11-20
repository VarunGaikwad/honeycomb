import assert from "node:assert/strict";
import test from "node:test";
import { classifyBash, classifyBashWithPaths } from "../bash-classify.ts";

test("allowlists simple read-only commands", () => {
  for (const command of [
    "ls -la", "cat a.txt", "head -n 4 a.txt", "tail a.txt", "grep needle a.txt", "rg needle src",
    "find src -name '*.ts'", "wc -l a.txt", "pwd", "echo hello", "which node", "tree src", "diff a b",
    "file image.png", "stat a.txt", "du -sh .", "df -h", "date", "whoami", "uname -a",
  ]) assert.equal(classifyBash(command), "readonly", command);
});

test("quoted and escaped operator characters are arguments, not chaining", () => {
  assert.equal(classifyBash('grep ";" file.txt'), "readonly");
  assert.equal(classifyBash("grep '&&' file.txt"), "readonly");
  assert.equal(classifyBash("grep \\; file.txt"), "readonly");
  assert.equal(classifyBash('echo "a > b"'), "readonly");
});

test("unquoted shell operators and newlines are unknown", () => {
  for (const command of [
    "ls; rm x", "ls && cat x", "ls || cat x", "ls | grep x", "ls &", "cat x > out", "cat < in",
    "cat <<EOF", "ls\ncat x", "ls\r\ncat x",
  ]) assert.equal(classifyBash(command), "unknown", command);
});

test("shell expansions are rejected even when quoted", () => {
  for (const command of [
    "echo $(curl x)", 'echo "$(curl x)"', "echo '`id`'", "echo ${HOME}", "echo '<(cat file)'", "echo \">(cat file)\"",
  ]) assert.equal(classifyBash(command), "unknown", command);
});

test("incomplete quoting, dangling escapes, and leading assignments fail closed", () => {
  for (const command of ["grep 'unterminated", 'grep "unterminated', "ls \\", "FOO=1 ls", "A=1 B=2 cat file", "FOO=1"]) {
    assert.equal(classifyBash(command), "unknown", command);
  }
  assert.equal(classifyBash(123 as unknown as string), "unknown");
});

test("git readonly allowlist is narrow", () => {
  for (const command of [
    "git status", "git log --oneline", "git diff --stat", "git show HEAD", "git branch", "git branch -a",
    "git remote -v", "git remote --verbose", "git rev-parse HEAD", "git blame file.ts",
  ]) assert.equal(classifyBash(command), "readonly", command);

  for (const command of [
    "git commit -m x", "git push", "git push --force", "git remote add origin url", "git branch new-name",
    "git branch -d old-name", "git branch -D old-name", "git branch -m old new", "git branch --copy old new",
    "git branch --list feature*", "git log --output=log.txt", "git diff -o diff.txt",
    "git diff --output=diff.txt", "git show --output=show.txt", "git log --output log.txt",
  ]) assert.equal(classifyBash(command), "unknown", command);
});

test("Git global options and external diff/textconv options fail closed", () => {
  for (const command of [
    "git -c core.pager=cat status", "git -C repo status", "git --exec-path=/tmp status", "git --exec-path /tmp status",
    "git --git-dir=.git status", "git --git-dir .git status", "git --work-tree=. status", "git --work-tree . status",
    "git -p log", "git --paginate log", "git log --ext-diff", "git diff --ext-diff", "git show --ext-diff",
    "git log --textconv", "git diff --textconv", "git show --textconv", "tree -o / --output",
  ]) assert.equal(classifyBash(command), "unknown", command);
});

test("find write and execution actions are unknown", () => {
  for (const action of ["-exec", "-execdir", "-ok", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]) {
    assert.equal(classifyBash(`find . ${action} /tmp/result`), "unknown", action);
  }
});

test("readonly commands return path operands for protected-path checks", () => {
  assert.deepEqual(classifyBashWithPaths("cat .env"), { classification: "readonly", pathArgs: [".env"] });
  assert.deepEqual(classifyBashWithPaths("grep -r KEY ~/.ssh"), {
    classification: "readonly",
    pathArgs: ["~/.ssh"],
  });
  assert.deepEqual(classifyBashWithPaths("grep -f .env file.txt"), {
    classification: "readonly",
    pathArgs: [".env", "file.txt"],
  });
  assert.deepEqual(classifyBashWithPaths("find -L ~/.ssh -name key"), {
    classification: "readonly",
    pathArgs: ["~/.ssh"],
  });
  assert.deepEqual(classifyBashWithPaths("git diff -- .env"), {
    classification: "readonly",
    pathArgs: [".env"],
  });
  assert.deepEqual(classifyBashWithPaths("git show HEAD:.env"), {
    classification: "readonly",
    pathArgs: [".env"],
  });
  assert.deepEqual(classifyBashWithPaths("git log HEAD:.env"), {
    classification: "readonly",
    pathArgs: [".env"],
  });
  assert.deepEqual(classifyBashWithPaths("git diff HEAD:/etc/passwd"), {
    classification: "readonly",
    pathArgs: ["/etc/passwd"],
  });
});

test("filesystem-safe commands return parsed path operands", () => {
  assert.deepEqual(classifyBashWithPaths("mkdir -p build"), {
    classification: "fs-safe",
    pathArgs: ["build"],
  });
  assert.deepEqual(classifyBashWithPaths("touch -r reference.txt new.txt"), {
    classification: "fs-safe",
    pathArgs: ["reference.txt", "new.txt"],
  });
  assert.deepEqual(classifyBashWithPaths("mv -- old.txt 'new name.txt'"), {
    classification: "fs-safe",
    pathArgs: ["old.txt", "new name.txt"],
  });
  assert.deepEqual(classifyBashWithPaths("cp -t build src/a.ts"), {
    classification: "fs-safe",
    pathArgs: ["build", "src/a.ts"],
  });
  assert.equal(classifyBash("mkdir"), "unknown");
  assert.equal(classifyBash("mv one"), "unknown");
  assert.equal(classifyBash("cp -Z a b"), "unknown");
  assert.equal(classifyBash("cp '$HOME/a' dest"), "unknown");
  assert.equal(classifyBash("cp '~other/a' dest"), "unknown");
  assert.equal(classifyBash("cp 'src/*.ts' dest"), "unknown");
});

test("unlisted commands and mutating options are unknown", () => {
  for (const command of [
    "npm install", "python script.py", "sed -i s/a/b/ file", "sed -n 1p file", "sudo ls", "date -s tomorrow",
    "date tomorrow", "rg --pre / --pre-glob", "rg --pre=cat file", "rg --pre-glob=*.txt KEY src",
  ]) {
    assert.equal(classifyBash(command), "unknown", command);
  }
});
