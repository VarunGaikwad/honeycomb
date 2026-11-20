import { lstatSync, realpathSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(homedir(), input.slice(2));
  }
  return input;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function isMissingPathError(error: unknown): boolean {
  return errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR";
}

/**
 * Resolve an existing or not-yet-created path through every existing symlink.
 * Missing path components are appended to the realpath of their nearest
 * existing ancestor. Dangling symlinks are followed too, so writes through
 * links to nonexistent outside targets are not mistaken for in-cwd paths.
 */
export function resolveReal(input: string, cwd: string = process.cwd()): string {
  if (typeof input !== "string" || input.length === 0) throw new TypeError("Path must be a non-empty string");

  let current = path.resolve(cwd, expandHome(input));
  const missingComponents: string[] = [];
  let followedSymlinks = 0;

  while (true) {
    try {
      let resolved = realpathSync(current);
      for (const component of missingComponents) resolved = path.join(resolved, component);
      return path.normalize(resolved);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }

    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }

    if (stat?.isSymbolicLink()) {
      if (++followedSymlinks > 40) throw new Error(`Too many symbolic links while resolving ${input}`);
      const destination = readlinkSync(current);
      current = path.isAbsolute(destination)
        ? path.resolve(destination)
        : path.resolve(path.dirname(current), destination);
      continue;
    }

    const parent = path.dirname(current);
    if (parent === current) throw new Error(`Could not resolve path: ${input}`);
    missingComponents.unshift(path.basename(current));
    current = parent;
  }
}

/** Return whether a path resolves under cwd, using a separator-safe realpath prefix. */
export function isInsideCwd(input: string, cwd: string): boolean {
  try {
    const realCwd = path.normalize(resolveReal(cwd, cwd));
    const realInput = path.normalize(resolveReal(input, cwd));
    const caseInsensitive = process.platform === "win32";
    const root = caseInsensitive ? realCwd.toLowerCase() : realCwd;
    const candidate = caseInsensitive ? realInput.toLowerCase() : realInput;
    const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    return candidate === root || candidate.startsWith(rootPrefix);
  } catch {
    // A resolution error is not proof that the path is inside the project.
    return false;
  }
}

function pathSegments(input: string): string[] {
  return input.split(/[\\/]+/).filter(Boolean);
}

function relativeToHome(home: string, target: string): string | undefined {
  const relative = path.relative(home, target);
  if (relative === "") return "";
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
  return relative;
}

/** Check whether a path is sensitive; resolution failures are treated as protected. */
export function isProtected(input: string, cwd: string = process.cwd()): boolean {
  let resolved: string;
  let realHome: string;
  try {
    resolved = resolveReal(input, cwd);
    realHome = resolveReal(homedir(), homedir());
  } catch {
    return true;
  }

  const caseInsensitive = process.platform === "win32";
  const normalizeName = (value: string) => caseInsensitive ? value.toLowerCase() : value;
  const segments = pathSegments(resolved).map(normalizeName);

  if (segments.some((segment) =>
    segment === ".git" ||
    segment === "node_modules" ||
    segment === ".env" ||
    segment.startsWith(".env.") ||
    segment.endsWith(".pem") ||
    segment.endsWith(".key") ||
    segment.startsWith("id_rsa")
  )) return true;

  const homeRelative = relativeToHome(realHome, resolved);
  if (homeRelative === undefined) return false;
  const homeSegments = pathSegments(homeRelative).map(normalizeName);
  if (homeSegments[0] === ".ssh" || homeSegments[0] === ".pi") return true;
  return homeSegments.length === 1 && [".bashrc", ".zshrc", ".profile"].includes(homeSegments[0]!);
}
