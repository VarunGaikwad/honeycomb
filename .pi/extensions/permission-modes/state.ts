import { isPermissionMode, type PermissionMode } from "./modes.ts";

export const MODE_ENTRY_TYPE = "permission-mode";

interface EntryLike {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read only the newest mode entry on the active session branch. */
export function restoreMode(entries: readonly unknown[]): PermissionMode | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index] as EntryLike | undefined;
    if (entry?.type !== "custom" || entry.customType !== MODE_ENTRY_TYPE) continue;
    return isRecord(entry.data) && isPermissionMode(entry.data.mode) ? entry.data.mode : undefined;
  }
  return undefined;
}

export interface InitialModeResolution {
  mode: PermissionMode;
  source: "cli" | "session" | "default";
  invalidCliMode: boolean;
  bypassFallback: boolean;
}

/** Resolve CLI > active-session entry > default, failing back to default for ungated bypass. */
export function resolveInitialMode(
  cliMode: string | undefined,
  restoredMode: PermissionMode | undefined,
  bypassEnabled: boolean,
): InitialModeResolution {
  const invalidCliMode = cliMode !== undefined && !isPermissionMode(cliMode);
  const source: InitialModeResolution["source"] = cliMode !== undefined
    ? "cli"
    : restoredMode !== undefined ? "session" : "default";
  const requested = cliMode !== undefined
    ? isPermissionMode(cliMode) ? cliMode : "default"
    : restoredMode ?? "default";
  const bypassFallback = requested === "bypassPermissions" && !bypassEnabled;

  return {
    mode: bypassFallback ? "default" : requested,
    source,
    invalidCliMode,
    bypassFallback,
  };
}

export function restorePlanTools(entries: readonly unknown[]): string[] | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index] as EntryLike | undefined;
    if (entry?.type !== "custom" || entry.customType !== MODE_ENTRY_TYPE) continue;
    if (!isRecord(entry.data) || entry.data.mode !== "plan" || !Array.isArray(entry.data.previousTools) ||
        !entry.data.previousTools.every((name: unknown) => typeof name === "string" && name.length > 0)) return undefined;
    return [...entry.data.previousTools] as string[];
  }
  return undefined;
}

export type AppendModeEntry = (customType: string, data: { mode: PermissionMode; previousTools?: string[] }) => void;

export function persistMode(mode: PermissionMode, appendEntry: AppendModeEntry, previousTools?: readonly string[]): void {
  appendEntry(MODE_ENTRY_TYPE, previousTools === undefined ? { mode } : { mode, previousTools: [...previousTools] });
}
