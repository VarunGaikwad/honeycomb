import { homedir } from "node:os";
import path from "node:path";
import { classifyBashWithPaths, type BashClass } from "./bash-classify.ts";
import { isInsideCwd, isProtected, resolveReal } from "./paths.ts";
import { matchRules, type RuleAction, type Rules } from "./rules.ts";

export type Mode = "default" | "acceptEdits" | "plan" | "auto" | "dontAsk" | "bypassPermissions";
export type Action = "allow" | "ask" | "deny";
export type VerdictSource = "hard-deny" | "user-deny" | "user-ask" | "user-allow" | "mode";

export interface Verdict {
  action: Action;
  reason: string;
  source: VerdictSource;
}

export interface ToolCall {
  toolName: string;
  input: Record<string, unknown>;
}

export interface PolicyCtx {
  cwd: string;
  planFilePath: string;
  rules: Rules;
  bypassEnabled: boolean;
}

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["edit", "write"]);
const SHELL_SEPARATORS = new Set([";", "&&", "||", "|", "&", "\n", "\r"]);
const HARD_WRITE_COMMANDS = new Set([
  "rm", "mkdir", "touch", "mv", "cp", "tee", "truncate", "shred", "chmod", "chown", "chgrp", "ln",
  "install", "sed", "curl", "wget",
]);

function verdict(action: Action, reason: string, source: VerdictSource = "mode"): Verdict {
  return { action, reason, source };
}

function baseName(word: string): string {
  const pieces = word.replace(/\\/g, "/").split("/");
  return (pieces[pieces.length - 1] ?? word).toLowerCase();
}

/** Small shell-word scanner for hard-deny checks; it never executes expansions. */
function shellTokens(command: string): string[] {
  const tokens: string[] = [];
  let word = "";
  let started = false;
  let quote: "single" | "double" | undefined;

  const flush = () => {
    if (started) tokens.push(word);
    word = "";
    started = false;
  };

  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (quote === "single") {
      if (char === "'") quote = undefined;
      else word += char;
      started = true;
      continue;
    }
    if (quote === "double") {
      if (char === '"') quote = undefined;
      else if (char === "\\" && command[i + 1] !== undefined) word += command[++i]!;
      else word += char;
      started = true;
      continue;
    }
    if (char === "\\" && command[i + 1] !== undefined) {
      word += command[++i]!;
      started = true;
      continue;
    }
    if (char === "'") {
      quote = "single";
      started = true;
      continue;
    }
    if (char === '"') {
      quote = "double";
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      if (char === "\n" || char === "\r") tokens.push(char);
      continue;
    }
    if (";&|<>".includes(char)) {
      flush();
      let operator = char;
      const next = command[i + 1];
      if (next === char && (char === "&" || char === "|" || char === ">" || char === "<")) {
        operator += next;
        i++;
      }
      tokens.push(operator);
      continue;
    }
    word += char;
    started = true;
  }
  flush();
  return tokens;
}

function isOperator(token: string): boolean {
  return SHELL_SEPARATORS.has(token) || token === ">" || token === ">>" || token === "<" || token === "<<";
}

function expandShellPath(input: string, cwd: string): string | undefined {
  if (input === "~") return homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) return path.join(homedir(), input.slice(2));
  if (input.startsWith("~")) return undefined;

  const variablePrefixes: Array<[string, string]> = [
    ["${HOME}", homedir()], ["$HOME", homedir()], ["${PWD}", cwd], ["$PWD", cwd],
  ];
  for (const [prefix, value] of variablePrefixes) {
    if (input === prefix) return value;
    if (input.startsWith(`${prefix}/`) || input.startsWith(`${prefix}\\`)) {
      return path.join(value, input.slice(prefix.length + 1));
    }
  }
  if (input.includes("$")) return undefined;
  return input;
}

function isSameRealPath(left: string, right: string, cwd: string): boolean {
  try {
    let a = resolveReal(left, cwd);
    let b = resolveReal(right, cwd);
    if (process.platform === "win32") {
      a = a.toLowerCase();
      b = b.toLowerCase();
    }
    return a === b;
  } catch {
    return false;
  }
}

function isRootOrCwdTarget(target: string, cwd: string): boolean {
  const normalized = target.replace(/\\/g, "/");
  const components = normalized.split("/").filter(Boolean);
  if (components.includes("..")) return true;
  if (normalized === "." || normalized === "./") return true;

  if (normalized === "~" || normalized === "$HOME" || normalized === "${HOME}" ||
      normalized === "$PWD" || normalized === "${PWD}") return true;
  if (["~/", "$HOME/", "${HOME}/", "$PWD/", "${PWD}/"].some((root) => normalized === root)) return true;

  const expanded = expandShellPath(target, cwd);
  if (!expanded) return true;
  const isPosixRoot = path.posix.isAbsolute(expanded) && path.posix.normalize(expanded) === "/";
  const isWinRoot = path.win32.isAbsolute(expanded) && path.win32.normalize(expanded) === path.win32.parse(expanded).root;
  if (isPosixRoot || isWinRoot) return true;
  return isSameRealPath(expanded, cwd, cwd) || isSameRealPath(expanded, homedir(), cwd);
}

function hasRecursiveRm(tokens: string[], cwd: string): boolean {
  for (let i = 0; i < tokens.length; i++) {
    if (baseName(tokens[i]!) !== "rm") continue;
    let recursive = false;
    let options = true;
    const targets: string[] = [];

    for (let j = i + 1; j < tokens.length && !isOperator(tokens[j]!); j++) {
      const arg = tokens[j]!;
      if (options && arg === "--") {
        options = false;
        continue;
      }
      if (options && arg === "--recursive") {
        recursive = true;
        continue;
      }
      if (options && arg.startsWith("-") && arg !== "-") {
        if (!arg.startsWith("--") && /r/i.test(arg.slice(1))) recursive = true;
        continue;
      }
      targets.push(arg);
    }

    if (recursive && targets.some((target) => isRootOrCwdTarget(target, cwd))) return true;
  }
  return false;
}

function hasDangerousChmod(tokens: string[], cwd: string): boolean {
  for (let i = 0; i < tokens.length; i++) {
    if (baseName(tokens[i]!) !== "chmod") continue;
    let recursive = false;
    let has777 = false;
    const targets: string[] = [];
    for (let j = i + 1; j < tokens.length && !isOperator(tokens[j]!); j++) {
      const arg = tokens[j]!;
      if (arg === "-R" || arg === "--recursive" || /^-[^-]*R/.test(arg)) recursive = true;
      else if (arg === "777") has777 = true;
      else if (!arg.startsWith("-")) targets.push(arg);
    }
    if (recursive && has777 && targets.some((target) => isRootOrCwdTarget(target, cwd))) return true;
  }
  return false;
}

function hasGitForcePush(tokens: string[]): boolean {
  for (let i = 0; i < tokens.length; i++) {
    if (baseName(tokens[i]!) !== "git") continue;
    let pushIndex = -1;
    for (let j = i + 1; j < tokens.length && !isOperator(tokens[j]!); j++) {
      if (tokens[j] === "push") {
        pushIndex = j;
        break;
      }
    }
    if (pushIndex === -1) continue;
    for (let j = pushIndex + 1; j < tokens.length && !isOperator(tokens[j]!); j++) {
      const arg = tokens[j]!;
      if (arg === "-f" || arg === "--force" || arg.startsWith("--force-with-lease")) return true;
    }
  }
  return false;
}

function effectiveCommandIndex(segment: string[]): number {
  let index = 0;
  while (index < segment.length) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[index]!)) {
      index++;
      continue;
    }
    const name = baseName(segment[index]!);
    if (name === "command" || name === "exec" || name === "builtin") {
      index++;
      if (segment[index] === "--") index++;
      continue;
    }
    if (name === "env") {
      index++;
      while (index < segment.length) {
        const arg = segment[index]!;
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
          index++;
          continue;
        }
        if (arg === "--") {
          index++;
          break;
        }
        if (!arg.startsWith("-")) break;
        if (["-u", "--unset", "-C", "--chdir"].includes(arg)) index += 2;
        else index++;
      }
      continue;
    }
    return index;
  }
  return index;
}

function hasDownloadPipeToShell(tokens: string[]): boolean {
  let pipelineHasDownload = false;
  let segment: string[] = [];
  const isFetch = (words: string[]) => {
    const index = effectiveCommandIndex(words);
    const name = baseName(words[index] ?? "");
    return name === "curl" || name === "wget";
  };
  const isShell = (words: string[]) => {
    const index = effectiveCommandIndex(words);
    const name = baseName(words[index] ?? "");
    if (name === "sh" || name === "bash") return true;
    if (name === "env" || name === "command" || name === "exec") {
      return words.slice(index + 1).some((word) => ["sh", "bash"].includes(baseName(word)));
    }
    return false;
  };
  const finishSegment = () => {
    if (isFetch(segment)) pipelineHasDownload = true;
    if (pipelineHasDownload && isShell(segment)) return true;
    segment = [];
    return false;
  };

  for (const token of tokens) {
    if (token === "|") {
      if (finishSegment()) return true;
      continue;
    }
    if (token === ";" || token === "&&" || token === "||" || token === "&" || token === "\n" || token === "\r") {
      if (finishSegment()) return true;
      pipelineHasDownload = false;
      continue;
    }
    segment.push(token);
  }
  return finishSegment();
}

function writeTargets(tokens: string[], call: ToolCall): string[] {
  const targets: string[] = [];

  if (call.toolName === "bash") {
    const command = call.input.command;
    if (typeof command === "string") {
      const detailed = classifyBashWithPaths(command);
      if (detailed.classification === "fs-safe") targets.push(...detailed.pathArgs);
    }
  }

  let segment: string[] = [];
  const inspectSegment = () => {
    if (segment.length === 0) return;
    const commandIndex = effectiveCommandIndex(segment);
    const commandName = baseName(segment[commandIndex] ?? "");
    const args = segment.slice(commandIndex + 1);

    if (HARD_WRITE_COMMANDS.has(commandName)) {
      let skipNextOutput = false;
      for (const arg of args) {
        if (skipNextOutput) {
          targets.push(arg);
          skipNextOutput = false;
          continue;
        }
        if (["-o", "-O", "--output", "--target-directory", "-t"].includes(arg)) {
          skipNextOutput = true;
          continue;
        }
        if (/^(?:of|--output|--target-directory)=/.test(arg)) {
          targets.push(arg.slice(arg.indexOf("=") + 1));
          continue;
        }
        if (!arg.startsWith("-") && !arg.includes("=")) targets.push(arg);
      }
    }

    if (commandName === "dd") {
      for (const arg of args) if (/^of=/i.test(arg)) targets.push(arg.slice(3));
    }
    segment = [];
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === ">" || token === ">>") {
      inspectSegment();
      if (tokens[i + 1] && !isOperator(tokens[i + 1]!)) targets.push(tokens[i + 1]!);
      continue;
    }
    if (isOperator(token)) {
      inspectSegment();
      continue;
    }
    segment.push(token);
  }
  inspectSegment();

  return targets;
}

function isProtectedBashWrite(call: ToolCall, cwd: string, tokens: string[]): boolean {
  for (const target of writeTargets(tokens, call)) {
    const expanded = expandShellPath(target, cwd);
    // An unresolved expansion in a known write target cannot be safely ruled out.
    if (!expanded || isProtected(expanded, cwd)) return true;
  }
  return false;
}

function hardDeniedBash(command: string, call: ToolCall, cwd: string): string | undefined {
  const tokens = shellTokens(command);
  if (tokens.some((token) => baseName(token) === "sudo")) return "Commands using sudo are hard-denied.";
  if (tokens.some((token) => baseName(token).startsWith("mkfs"))) return "Filesystem formatting commands are hard-denied.";
  if (tokens.some((token) => baseName(token) === "dd") && tokens.some((token) => /^of=\/dev\//i.test(token))) {
    return "Writing directly to a device with dd is hard-denied.";
  }
  if (hasRecursiveRm(tokens, cwd)) return "Recursive removal of a filesystem root, home, parent, or cwd is hard-denied.";
  if (hasDangerousChmod(tokens, cwd)) return "Recursive chmod 777 on a filesystem root or cwd is hard-denied.";
  if (/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(command)) {
    return "Fork-bomb commands are hard-denied.";
  }
  if (hasDownloadPipeToShell(tokens)) return "Piping downloaded content into a shell is hard-denied.";
  if (hasGitForcePush(tokens)) return "Force-pushing Git changes is hard-denied.";
  if (isProtectedBashWrite(call, cwd, tokens)) return "Writes to protected paths are hard-denied.";
  return undefined;
}

function hardDeny(call: ToolCall, ctx: PolicyCtx): string | undefined {
  if (WRITE_TOOLS.has(call.toolName)) {
    const filePath = call.input.path;
    if (typeof filePath !== "string" || filePath.length === 0) return "Cannot safely determine the write target.";
    if (isProtected(filePath, ctx.cwd)) return `Write to protected path is hard-denied: ${filePath}`;
  }

  if (call.toolName === "bash") {
    const command = call.input.command;
    if (typeof command !== "string") return "Cannot safely inspect the bash command.";
    return hardDeniedBash(command, call, ctx.cwd);
  }
  return undefined;
}

function readPathRequiresApproval(inputPath: string, cwd: string): boolean {
  const expanded = expandShellPath(inputPath, cwd);
  if (!expanded) return true;
  return isProtected(expanded, cwd) || !isInsideCwd(expanded, cwd);
}

function protectedReadReason(call: ToolCall, ctx: PolicyCtx): string | undefined {
  if (READ_TOOLS.has(call.toolName)) {
    const inputPath = call.input.path;
    if (typeof inputPath !== "string" || inputPath.length === 0) {
      return "Cannot safely determine the read path; approval is required.";
    }
    if (readPathRequiresApproval(inputPath, ctx.cwd)) {
      return `Reading protected or outside-cwd path requires approval: ${inputPath}`;
    }
  }

  if (call.toolName === "bash" && typeof call.input.command === "string") {
    const detailed = classifyBashWithPaths(call.input.command);
    if (detailed.classification !== "readonly") return undefined;
    for (const inputPath of detailed.pathArgs) {
      if (/[$*?\[\]{}]/.test(inputPath) || (inputPath.startsWith("~") && inputPath !== "~" && !inputPath.startsWith("~/") && !inputPath.startsWith("~\\"))) {
        return `Bash path operand cannot be safely resolved and requires approval: ${inputPath}`;
      }
      if (readPathRequiresApproval(inputPath, ctx.cwd)) {
        return `Bash read of protected or outside-cwd path requires approval: ${inputPath}`;
      }
    }
  }
  return undefined;
}

function isWriteTool(call: ToolCall): boolean {
  return WRITE_TOOLS.has(call.toolName);
}

function isPlanFileWrite(call: ToolCall, ctx: PolicyCtx): boolean {
  if (!isWriteTool(call) || typeof call.input.path !== "string") return false;
  return isInsideCwd(call.input.path, ctx.cwd) && isSameRealPath(call.input.path, ctx.planFilePath, ctx.cwd);
}

function fileWriteInsideCwd(call: ToolCall, ctx: PolicyCtx): boolean {
  return typeof call.input.path === "string" && isInsideCwd(call.input.path, ctx.cwd);
}

function bashClassification(call: ToolCall): { classification: BashClass; pathArgs: string[] } | undefined {
  if (call.toolName !== "bash" || typeof call.input.command !== "string") return undefined;
  return classifyBashWithPaths(call.input.command);
}

function fsSafePathsInsideCwd(pathArgs: string[], ctx: PolicyCtx): boolean {
  return pathArgs.length > 0 && pathArgs.every((arg) => isInsideCwd(arg, ctx.cwd));
}

function modeDecision(mode: Mode, call: ToolCall, ctx: PolicyCtx): Verdict {
  if (READ_TOOLS.has(call.toolName)) return verdict("allow", "Read-only tool allowed by mode.");

  if (isWriteTool(call)) {
    switch (mode) {
      case "default": return verdict("ask", "File edits require approval in default mode.");
      case "acceptEdits":
        return fileWriteInsideCwd(call, ctx)
          ? verdict("allow", "Edit is inside the working directory.")
          : verdict("ask", "Edit is outside the working directory.");
      case "plan":
        return isPlanFileWrite(call, ctx)
          ? verdict("allow", "Only the active plan file may be written in plan mode.")
          : verdict("deny", "Plan mode denies edits outside the active plan file.");
      case "auto":
        return fileWriteInsideCwd(call, ctx)
          ? verdict("allow", "Edit is inside the working directory.")
          : verdict("ask", "Edit is outside the working directory and needs review.");
      case "dontAsk": return verdict("deny", "No user allow-rule permits this file edit in dontAsk mode.");
      case "bypassPermissions": return verdict("allow", "File edit allowed by bypass mode.");
    }
  }

  const bash = bashClassification(call);
  if (bash) {
    switch (mode) {
      case "default":
        return bash.classification === "readonly"
          ? verdict("allow", "Allowlisted read-only bash command.")
          : verdict("ask", "Bash command is not read-only and needs approval.");
      case "acceptEdits":
        if (bash.classification === "readonly") return verdict("allow", "Allowlisted read-only bash command.");
        if (bash.classification === "fs-safe" && fsSafePathsInsideCwd(bash.pathArgs, ctx)) {
          return verdict("allow", "Filesystem-safe bash paths are inside the working directory.");
        }
        return verdict("ask", "Bash command or path requires approval.");
      case "plan":
        return bash.classification === "readonly"
          ? verdict("allow", "Allowlisted read-only bash command in plan mode.")
          : verdict("deny", "Plan mode allows only read-only bash commands.");
      case "auto":
        if (bash.classification === "readonly") return verdict("allow", "Allowlisted read-only bash command.");
        if (bash.classification === "fs-safe" && fsSafePathsInsideCwd(bash.pathArgs, ctx)) {
          return verdict("allow", "Filesystem-safe bash paths are inside the working directory.");
        }
        return verdict("ask", "Bash command requires review in auto mode.");
      case "dontAsk":
        return bash.classification === "readonly"
          ? verdict("allow", "Allowlisted read-only bash command in dontAsk mode.")
          : verdict("deny", "Bash command has no allow-rule in dontAsk mode.");
      case "bypassPermissions": return verdict("allow", "Bash command allowed by bypass mode.");
    }
  }

  switch (mode) {
    case "plan": return verdict("deny", `Unknown tool "${call.toolName}" is denied in plan mode.`);
    case "dontAsk": return verdict("deny", `Unknown tool "${call.toolName}" is denied in dontAsk mode.`);
    case "bypassPermissions": return verdict("allow", `Unknown tool "${call.toolName}" is allowed by bypass mode.`);
    default: return verdict("ask", `Unknown tool "${call.toolName}" requires approval.`);
  }
}

/** Apply hard-denies, protected-read handling, user rules, then the selected mode. */
export function decide(mode: Mode, call: ToolCall, ctx: PolicyCtx): Verdict {
  if (!call || typeof call.toolName !== "string" || !call.input || typeof call.input !== "object" ||
      !ctx || typeof ctx.cwd !== "string" || typeof ctx.planFilePath !== "string" || !ctx.rules || typeof ctx.rules !== "object") {
    return verdict("deny", "Malformed tool call or policy context cannot be evaluated safely.");
  }
  if (!["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"].includes(mode)) {
    return verdict("deny", "Unknown permission mode is denied.");
  }

  const hardDenyReason = hardDeny(call, ctx);
  if (hardDenyReason) return verdict("deny", hardDenyReason, "hard-deny");

  if (mode === "bypassPermissions" && !ctx.bypassEnabled) {
    return verdict("deny", "bypassPermissions was not enabled when this session started.");
  }

  const ruleAction: RuleAction | undefined = matchRules(call, ctx.rules, ctx.cwd);
  if (ruleAction === "deny") return verdict("deny", "A user deny-rule matched this call.", "user-deny");
  if (ruleAction === "ask") {
    if (mode === "dontAsk") return verdict("deny", "A user ask-rule matched; dontAsk mode cannot prompt.", "user-ask");
    return verdict("ask", "A user ask-rule matched this call.", "user-ask");
  }

  if (mode !== "bypassPermissions") {
    const readReason = protectedReadReason(call, ctx);
    if (readReason) {
      return mode === "dontAsk"
        ? verdict("deny", `Approval is required but dontAsk mode cannot prompt: ${readReason}`)
        : verdict("ask", readReason);
    }
  }

  if (ruleAction === "allow") {
    if (mode !== "plan" || !isWriteTool(call) || isPlanFileWrite(call, ctx)) {
      return verdict("allow", "A user allow-rule matched this call.", "user-allow");
    }
  }

  return modeDecision(mode, call, ctx);
}
