export type BashClass = "readonly" | "fs-safe" | "unknown";

export interface BashClassification {
  classification: BashClass;
  /** Parsed path operands for readonly and fs-safe commands; empty for unknown commands. */
  pathArgs: string[];
}

const READONLY_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "grep", "rg", "find", "wc", "pwd", "echo", "which", "tree",
  "diff", "file", "stat", "du", "df", "date", "whoami", "uname",
]);

const FS_SAFE_COMMANDS = new Set(["mkdir", "touch", "mv", "cp"]);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELL_EXPANSION = ["$(", "`", "${", "<(", ">("];

interface TokenizeResult {
  tokens: string[];
}

/**
 * Tokenize only the quoting and escaping needed to identify a single simple
 * command. Any unquoted shell control operator is rejected rather than parsed.
 */
function tokenize(command: string): TokenizeResult | undefined {
  if (SHELL_EXPANSION.some((part) => command.includes(part)) || command.includes("\0")) return undefined;

  const tokens: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quote: "single" | "double" | undefined;

  const flush = () => {
    if (tokenStarted) tokens.push(token);
    token = "";
    tokenStarted = false;
  };

  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;

    if (quote === "single") {
      if (char === "'") quote = undefined;
      else token += char;
      tokenStarted = true;
      continue;
    }

    if (quote === "double") {
      if (char === '"') {
        quote = undefined;
        tokenStarted = true;
      } else if (char === "\\") {
        const next = command[i + 1];
        if (next === undefined) return undefined;
        if (next === "\n") {
          i++;
        } else {
          token += next;
          tokenStarted = true;
          i++;
        }
      } else {
        token += char;
        tokenStarted = true;
      }
      continue;
    }

    if (char === "\\") {
      const next = command[i + 1];
      if (next === undefined) return undefined;
      if (next !== "\n") {
        token += next;
        tokenStarted = true;
      }
      i++;
      continue;
    }

    if (char === "'") {
      quote = "single";
      tokenStarted = true;
      continue;
    }
    if (char === '"') {
      quote = "double";
      tokenStarted = true;
      continue;
    }

    // Shell control operators are deliberately not evaluated in v1.
    if (";&|<>".includes(char) || char === "\n" || char === "\r") return undefined;

    if (/\s/.test(char)) {
      flush();
      continue;
    }

    token += char;
    tokenStarted = true;
  }

  if (quote !== undefined) return undefined;
  flush();
  return { tokens };
}

const FIND_MUTATING_OR_REDIRECTING = new Set([
  "-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls",
]);

function hasUnsafeFindAction(args: string[]): boolean {
  return args.some((arg) => {
    if (FIND_MUTATING_OR_REDIRECTING.has(arg)) return true;
    return /^-(?:fprint|fprint0|fprintf|fls)(?:=|$)/.test(arg);
  });
}

const READONLY_BRANCH_FLAGS = new Set([
  "-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "--no-color", "--no-column",
  "--list", "-l", "--show-current", "--merged", "--no-merged", "--contains", "--no-contains",
  "--points-at", "--ignore-case", "--omit-empty",
]);

function isReadonlyGitBranch(args: string[]): boolean {
  for (const arg of args) {
    if (READONLY_BRANCH_FLAGS.has(arg)) continue;
    if (arg.startsWith("--sort=") || arg.startsWith("--format=") || arg.startsWith("--color=")) continue;
    // Any positional argument may create or rename a branch; stay conservative.
    return false;
  }
  return true;
}

const GIT_GLOBAL_OPTIONS = new Set([
  "-c", "-C", "--exec-path", "--git-dir", "--work-tree", "-p", "--paginate",
]);

function isGitGlobalOption(arg: string): boolean {
  return GIT_GLOBAL_OPTIONS.has(arg) || /^-[cC].+/.test(arg) ||
    ["--exec-path=", "--git-dir=", "--work-tree="].some((prefix) => arg.startsWith(prefix));
}

function classifyGit(tokens: string[]): BashClass {
  const subcommand = tokens[1];
  if (!subcommand || isGitGlobalOption(subcommand)) return "unknown";

  if (["status", "log", "diff", "show", "rev-parse", "blame"].includes(subcommand)) {
    const args = tokens.slice(2);
    // Read-oriented Git options can redirect output or run repo-configured external tools.
    if (args.some((arg) => arg === "-o" || arg === "--output" || arg.startsWith("--output="))) return "unknown";
    if (["log", "diff", "show"].includes(subcommand) && args.some((arg) =>
      arg === "--ext-diff" || arg.startsWith("--ext-diff=") || arg === "--textconv" || arg.startsWith("--textconv="),
    )) return "unknown";
    return "readonly";
  }
  if (subcommand === "branch") return isReadonlyGitBranch(tokens.slice(2)) ? "readonly" : "unknown";
  if (subcommand === "remote") {
    return tokens.length === 3 && (tokens[2] === "-v" || tokens[2] === "--verbose") ? "readonly" : "unknown";
  }
  return "unknown";
}

const GREP_VALUE_OPTIONS = new Set([
  "-m", "--max-count", "-A", "--after-context", "-B", "--before-context", "-C", "--context",
  "-D", "--devices", "-d", "--directories", "--binary-files", "--label",
]);

function parseGrepPathArgs(args: string[]): string[] | undefined {
  const pathArgs: string[] = [];
  let havePattern = false;
  let optionsEnded = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!optionsEnded && arg === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && arg.startsWith("-")) {
      if (arg === "-e" || arg === "--regexp") {
        if (args[++i] === undefined) return undefined;
        havePattern = true;
        continue;
      }
      if (arg === "-f" || arg === "--file") {
        const patternFile = args[++i];
        if (patternFile === undefined) return undefined;
        pathArgs.push(patternFile);
        havePattern = true;
        continue;
      }
      if (arg.startsWith("--regexp=")) {
        havePattern = true;
        continue;
      }
      if (arg.startsWith("--file=")) {
        const patternFile = arg.slice("--file=".length);
        if (!patternFile) return undefined;
        pathArgs.push(patternFile);
        havePattern = true;
        continue;
      }
      if (/^-e.+/.test(arg)) {
        havePattern = true;
        continue;
      }
      if (/^-f.+/.test(arg)) {
        pathArgs.push(arg.slice(2));
        havePattern = true;
        continue;
      }
      if (GREP_VALUE_OPTIONS.has(arg)) {
        if (args[++i] === undefined) return undefined;
      }
      continue;
    }

    if (!havePattern) havePattern = true;
    else pathArgs.push(arg);
  }

  return pathArgs.filter(Boolean);
}

function parseFindPathArgs(args: string[]): string[] {
  const paths: string[] = [];
  let expectingPathAfterSeparator = false;
  for (const arg of args) {
    if (arg === "--") {
      expectingPathAfterSeparator = true;
      continue;
    }
    if (!expectingPathAfterSeparator && ["-H", "-L", "-P"].includes(arg)) continue;
    if (!expectingPathAfterSeparator && (arg.startsWith("-") || arg === "!" || arg === "(")) break;
    paths.push(arg);
  }
  return paths.length > 0 ? paths : ["."];
}

function parseSimplePathArgs(args: string[]): string[] {
  const paths: string[] = [];
  let optionsEnded = false;
  for (const arg of args) {
    if (!optionsEnded && arg === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && arg.startsWith("-") && arg !== "-") continue;
    paths.push(arg);
  }
  return paths;
}

function readonlyPathArgs(tokens: string[]): string[] {
  const name = tokens[0]!;
  const args = tokens.slice(1);
  if (name === "find") return parseFindPathArgs(args);
  if (name === "git") {
    const separator = tokens.indexOf("--", 2);
    const args = tokens.slice(2, separator === -1 ? undefined : separator);
    const revisionPaths = args.flatMap((arg) => {
      if (arg.startsWith("-")) return [];
      const colon = arg.lastIndexOf(":");
      return [colon > 0 ? arg.slice(colon + 1) : arg];
    });
    return separator === -1 ? revisionPaths : [...revisionPaths, ...tokens.slice(separator + 1)];
  }
  if (["ls", "cat", "head", "tail", "wc", "diff", "file", "stat", "du", "df", "tree"].includes(name)) {
    return parseSimplePathArgs(args);
  }
  return [];
}

const FS_SAFE_OPTIONS: Record<string, Set<string>> = {
  mkdir: new Set(["-p", "--parents", "-v", "--verbose"]),
  touch: new Set(["-a", "-m", "-c", "--no-create", "-h", "--no-dereference", "-f", "--force"]),
  mv: new Set([
    "-f", "--force", "-i", "--interactive", "-n", "--no-clobber", "-u", "--update", "-v", "--verbose",
    "-T", "--no-target-directory", "--strip-trailing-slashes", "-b", "--backup",
  ]),
  cp: new Set([
    "-a", "--archive", "-f", "--force", "-i", "--interactive", "-l", "--link", "-L", "--dereference",
    "-P", "--no-dereference", "-p", "--preserve", "-R", "-r", "--recursive", "-s", "--symbolic-link",
    "-u", "--update", "-v", "--verbose", "-x", "--one-file-system", "-H", "-d", "--no-clobber", "-n",
    "--remove-destination", "-b", "--backup", "--attributes-only", "--copy-contents", "--no-preserve",
  ]),
};

const VALUE_OPTIONS: Record<string, Record<string, "path" | "value">> = {
  mkdir: { "-m": "value", "--mode": "value" },
  touch: {
    "-t": "value", "-d": "value", "--date": "value", "-r": "path", "--reference": "path", "--time": "value",
  },
  mv: { "-t": "path", "--target-directory": "path" },
  cp: {
    "-t": "path", "--target-directory": "path", "-S": "value", "--suffix": "value",
  },
};

const INLINE_VALUE_OPTIONS: Record<string, Array<{ prefix: string; kind: "path" | "value" }>> = {
  mkdir: [{ prefix: "--mode=", kind: "value" }],
  touch: [
    { prefix: "--date=", kind: "value" }, { prefix: "--reference=", kind: "path" }, { prefix: "--time=", kind: "value" },
  ],
  mv: [{ prefix: "--target-directory=", kind: "path" }],
  cp: [{ prefix: "--target-directory=", kind: "path" }, { prefix: "--suffix=", kind: "value" }],
};

const FS_EXPANSION = /[$*?\[\]{}]/;

function parseFsSafePathArgs(tokens: string[]): string[] | undefined {
  const command = tokens[0]!;
  const allowedOptions = FS_SAFE_OPTIONS[command]!;
  const valueOptions = VALUE_OPTIONS[command]!;
  const inlineOptions = INLINE_VALUE_OPTIONS[command] ?? [];
  const pathArgs: string[] = [];
  let optionsEnded = false;

  for (let i = 1; i < tokens.length; i++) {
    const arg = tokens[i]!;

    if (optionsEnded) {
      pathArgs.push(arg);
      continue;
    }
    if (arg === "--") {
      optionsEnded = true;
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") {
      pathArgs.push(arg);
      continue;
    }

    const inlineOption = inlineOptions.find((option) => arg.startsWith(option.prefix));
    if (inlineOption) {
      const value = arg.slice(inlineOption.prefix.length);
      if (!value) return undefined;
      if (inlineOption.kind === "path") pathArgs.push(value);
      continue;
    }

    const valueKind = valueOptions[ arg ];
    if (valueKind) {
      const value = tokens[++i];
      if (value === undefined) return undefined;
      if (valueKind === "path") pathArgs.push(value);
      continue;
    }

    if (!allowedOptions.has(arg)) return undefined;
  }

  const minPaths = command === "mv" || command === "cp" ? 2 : 1;
  const unsupportedTildeExpansion = pathArgs.some((arg) =>
    arg.startsWith("~") && arg !== "~" && !arg.startsWith("~/") && !arg.startsWith("~\\"),
  );
  if (pathArgs.length < minPaths || pathArgs.some((arg) => FS_EXPANSION.test(arg)) || unsupportedTildeExpansion) {
    return undefined;
  }
  return pathArgs;
}

/** Classifies a command and includes path operands for fs-safe commands. */
export function classifyBashWithPaths(command: string): BashClassification {
  const unknown: BashClassification = { classification: "unknown", pathArgs: [] };
  if (typeof command !== "string" || command.trim().length === 0) return unknown;

  const parsed = tokenize(command);
  if (!parsed || parsed.tokens.length === 0) return unknown;

  const tokens = parsed.tokens;
  if (ENV_ASSIGNMENT.test(tokens[0]!)) return unknown;

  const name = tokens[0]!;
  if (READONLY_COMMANDS.has(name)) {
    const args = tokens.slice(1);
    if (name === "find" && hasUnsafeFindAction(args)) return unknown;
    if (name === "rg" && args.some((arg) =>
      arg === "--pre" || arg.startsWith("--pre=") || arg === "--pre-glob" || arg.startsWith("--pre-glob="),
    )) return unknown;
    if (name === "date" && args.some((arg) =>
      arg === "-s" || arg === "--set" || arg.startsWith("--set=") || !arg.startsWith("-"),
    )) return unknown;
    if (name === "tree" && args.some((arg) =>
      arg === "-o" || arg.startsWith("-o") || arg === "--output" || arg.startsWith("--output="),
    )) return unknown;
    if (name === "grep" || name === "rg") {
      const pathArgs = parseGrepPathArgs(args);
      if (!pathArgs) return unknown;
      return { classification: "readonly", pathArgs };
    }
    return { classification: "readonly", pathArgs: readonlyPathArgs(tokens) };
  }
  if (name === "git") {
    const classification = classifyGit(tokens);
    return { classification, pathArgs: classification === "readonly" ? readonlyPathArgs(tokens) : [] };
  }
  if (name === "sed") {
    // sed is not an allowlisted command; in particular, in-place edits are never safe.
    return unknown;
  }
  if (FS_SAFE_COMMANDS.has(name)) {
    const pathArgs = parseFsSafePathArgs(tokens);
    if (!pathArgs) return unknown;
    return { classification: "fs-safe", pathArgs };
  }

  return unknown;
}

/** Classifies a single shell command conservatively using an allowlist. */
export function classifyBash(command: string): BashClass {
  return classifyBashWithPaths(command).classification;
}
