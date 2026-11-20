import { homedir } from "node:os";
import path from "node:path";

export type RuleAction = "allow" | "ask" | "deny";

export interface Rules {
  allow?: readonly string[];
  ask?: readonly string[];
  deny?: readonly string[];
}

export interface RuleCall {
  toolName: string;
  input: Record<string, unknown>;
}

function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) return path.join(homedir(), input.slice(2));
  return input;
}

function windowsPathStyle(input: string, cwd: string): boolean {
  return process.platform === "win32" ||
    /^[A-Za-z]:[\\/]/.test(input) ||
    /^[A-Za-z]:[\\/]/.test(cwd) ||
    input.startsWith("\\\\") ||
    cwd.startsWith("\\\\");
}

/** Return a lexical cwd-relative path with platform separators normalized to `/`. */
export function cwdRelativePath(input: string, cwd: string): string {
  const expanded = expandHome(input);
  const useWindowsPaths = windowsPathStyle(expanded, cwd);
  const pathApi = useWindowsPaths ? path.win32 : path.posix;
  const normalizedInput = useWindowsPaths
    ? expanded.replace(/\//g, "\\")
    : expanded.replace(/\\/g, "/");
  const normalizedCwd = useWindowsPaths ? cwd.replace(/\//g, "\\") : cwd.replace(/\\/g, "/");
  const base = pathApi.resolve(normalizedCwd);
  const absolute = pathApi.isAbsolute(normalizedInput)
    ? pathApi.resolve(normalizedInput)
    : pathApi.resolve(base, normalizedInput);
  return pathApi.relative(base, absolute).replace(/[\\/]+/g, "/");
}

/** Collapse whitespace between shell words while preserving quoted/escaped text. */
export function normalizeBashCommand(command: string): string {
  let result = "";
  let quote: "single" | "double" | undefined;
  let escaped = false;
  let pendingSpace = false;

  for (const char of command) {
    if (escaped) {
      if (pendingSpace) result += " ";
      pendingSpace = false;
      result += char;
      escaped = false;
      continue;
    }

    if (char === "\\" && quote !== "single") {
      if (pendingSpace) result += " ";
      pendingSpace = false;
      result += char;
      escaped = true;
      continue;
    }

    if (quote === "single") {
      result += char;
      if (char === "'") quote = undefined;
      continue;
    }

    if (quote === "double") {
      result += char;
      if (char === '"') quote = undefined;
      continue;
    }

    if (char === "'") {
      if (pendingSpace && result.length > 0) result += " ";
      pendingSpace = false;
      result += char;
      quote = "single";
    } else if (char === '"') {
      if (pendingSpace && result.length > 0) result += " ";
      pendingSpace = false;
      result += char;
      quote = "double";
    } else if (/[ \t\f\v]/.test(char)) {
      pendingSpace = result.length > 0;
    } else {
      if (pendingSpace && result.length > 0) result += " ";
      pendingSpace = false;
      result += char;
    }
  }

  return result;
}

function parseRule(rule: string): { toolName: string; pattern: string } | undefined {
  if (typeof rule !== "string") return undefined;
  const separator = rule.indexOf(":");
  if (separator <= 0) return undefined;
  const toolName = rule.slice(0, separator);
  const pattern = rule.slice(separator + 1);
  if (!toolName || !pattern) return undefined;
  return { toolName, pattern };
}

function matchesBashPattern(command: string, pattern: string): boolean {
  const normalizedCommand = normalizeBashCommand(command);
  const normalizedPattern = normalizeBashCommand(pattern);
  const firstStar = normalizedPattern.indexOf("*");

  if (firstStar === -1) return normalizedCommand === normalizedPattern;
  if (firstStar !== normalizedPattern.length - 1 || normalizedPattern.lastIndexOf("*") !== firstStar) return false;
  return normalizedCommand.startsWith(normalizedPattern.slice(0, -1));
}

function escapeRegex(char: string): string {
  return /[\\^$+?.()|\[\]{}]/.test(char) ? `\\${char}` : char;
}

/** Convert the documented `*`, `**`, and `?` file glob syntax to an anchored regex. */
function globRegex(pattern: string, caseInsensitive: boolean): RegExp | undefined {
  const normalized = pattern.replace(/\\/g, "/");
  let source = "^";

  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i]!;
    if (char === "*") {
      if (normalized[i + 1] === "*") {
        i++;
        if (normalized[i + 1] === "/") {
          source += "(?:.*/)?";
          i++;
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegex(char);
    }
  }

  try {
    return new RegExp(`${source}$`, caseInsensitive ? "i" : "");
  } catch {
    return undefined;
  }
}

/** Match a single `<toolName>:<pattern>` rule against a tool call. */
export function matchesRule(call: RuleCall, rule: string, cwd: string = process.cwd()): boolean {
  if (!call || typeof call.toolName !== "string" || !call.input || typeof call.input !== "object") return false;
  if (typeof rule !== "string") return false;
  const parsedRule = parseRule(rule);
  if (!parsedRule || parsedRule.toolName !== call.toolName) return false;

  if (call.toolName === "bash") {
    const command = call.input.command;
    return typeof command === "string" && matchesBashPattern(command, parsedRule.pattern);
  }

  const inputPath = call.input.path;
  if (typeof inputPath !== "string" || inputPath.length === 0) return false;

  const windows = windowsPathStyle(inputPath, cwd);
  const filePath = cwdRelativePath(inputPath, cwd);
  const pattern = parsedRule.pattern.replace(/\\/g, "/");
  const matcher = globRegex(pattern, windows);
  return matcher?.test(filePath) ?? false;
}

/** Return the first matching action in security order: deny, ask, then allow. */
export function matchRules(
  call: RuleCall,
  rules: Rules,
  cwd: string = process.cwd(),
): RuleAction | undefined {
  if (!rules || typeof rules !== "object") return undefined;
  for (const action of ["deny", "ask", "allow"] as const) {
    const patterns = rules[action];
    if (Array.isArray(patterns) && patterns.some((rule) => matchesRule(call, rule, cwd))) return action;
  }
  return undefined;
}

/** Merge global and project rule lists without allowing projects to grant permissions. */
export function mergeRuleSources(globalRules: Rules, projectRules: Rules = {}): Rules {
  const mergeRestrictive = (key: "ask" | "deny") => [
    ...new Set([
      ...(Array.isArray(globalRules?.[key]) ? globalRules[key] : []),
      ...(Array.isArray(projectRules?.[key]) ? projectRules[key] : []),
    ]),
  ];

  return {
    allow: [...new Set(Array.isArray(globalRules?.allow) ? globalRules.allow : [])],
    ask: mergeRestrictive("ask"),
    deny: mergeRestrictive("deny"),
  };
}
