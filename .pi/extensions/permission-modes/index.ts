import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { decide, type Mode as PolicyMode, type PolicyCtx, type ToolCall, type Verdict } from "./policy.ts";
import { normalizeBashCommand, type Rules } from "./rules.ts";
import { resolveReal } from "./paths.ts";
import { formatModeList, isPermissionMode, MODE_INFO, nextCycleMode, PERMISSION_MODES, type PermissionMode } from "./modes.ts";
import { persistMode, resolveInitialMode, restoreMode } from "./state.ts";

const STATUS_KEY = "permission-modes";
const ALLOW_ONCE = "Allow once";
const ALLOW_SESSION = "Allow for this session";
const DENY = "Deny";

interface ToolCallEventLike {
  toolName: unknown;
  input: unknown;
}

interface PermissionContextLike {
  cwd: string;
  hasUI: boolean;
  ui: {
    select(title: string, options: string[]): Promise<string | undefined>;
  };
}

export type PolicyDecider = (mode: PolicyMode, call: ToolCall, ctx: PolicyCtx) => Verdict;

export interface ToolCallHandlerOptions {
  getMode: () => PermissionMode;
  isBypassEnabled: () => boolean;
  policy?: PolicyDecider;
  rules?: Rules;
}

export interface ToolCallHandler {
  handle(event: ToolCallEventLike, ctx: PermissionContextLike): Promise<{ block: true; reason: string } | undefined>;
  clearSessionApprovals(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeInputValue(
  value: unknown,
  key: string | undefined,
  toolName: string,
  cwd: string,
  seen: Set<object>,
): unknown {
  if (typeof value === "string") {
    if (toolName === "bash" && key === "command") return normalizeBashCommand(value);
    if (key === "path") {
      try {
        return resolveReal(value, cwd);
      } catch {
        return value;
      }
    }
    return value;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number" || value === undefined) return value;
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("Circular tool input");
    seen.add(value);
    const result = value.map((item) => normalizeInputValue(item, undefined, toolName, cwd, seen));
    seen.delete(value);
    return result;
  }
  if (!isRecord(value) || seen.has(value)) throw new TypeError("Unsupported tool input");
  seen.add(value);
  const result: Record<string, unknown> = {};
  for (const name of Object.keys(value).sort()) {
    result[name] = normalizeInputValue(value[name], name, toolName, cwd, seen);
  }
  seen.delete(value);
  return result;
}

function stableSerialize(value: unknown): string {
  if (value === undefined) return "u";
  if (value === null) return "null";
  if (typeof value === "string") return `s${JSON.stringify(value)}`;
  if (typeof value === "boolean") return value ? "b1" : "b0";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Non-finite tool input");
    return `n${String(value)}`;
  }
  if (Array.isArray(value)) return `a[${value.map(stableSerialize).join(",")}]`;
  if (isRecord(value)) {
    return `o{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }
  throw new TypeError("Unsupported tool input");
}

/** Exact, in-memory key: no rule syntax or wildcard matching is used for session grants. */
function sessionApprovalKey(call: ToolCall, cwd: string): string | undefined {
  try {
    const realCwd = resolveReal(cwd, cwd);
    const normalized = normalizeInputValue(call.input, undefined, call.toolName, cwd, new Set());
    return `${call.toolName}\0${realCwd}\0${stableSerialize(normalized)}`;
  } catch {
    return undefined;
  }
}

function blocked(reason: string): { block: true; reason: string } {
  return { block: true, reason };
}

function verdictReason(verdict: Verdict): string {
  return typeof verdict.reason === "string" && verdict.reason.length > 0
    ? verdict.reason
    : "The permission policy returned no explanation.";
}

/** Build a fail-closed Pi tool-call adapter. Kept independently testable without Pi runtime APIs. */
export function createToolCallHandler(options: ToolCallHandlerOptions): ToolCallHandler {
  const sessionApprovals = new Set<string>();
  const policy = options.policy ?? decide;

  return {
    clearSessionApprovals: () => sessionApprovals.clear(),
    handle: async (event, ctx) => {
      try {
        if (!event || typeof event.toolName !== "string" || event.toolName.length === 0 || !ctx || typeof ctx.cwd !== "string") {
          return blocked("Malformed tool call cannot be evaluated safely.");
        }
        if (!isRecord(event.input)) return blocked("Tool input is not a record; tool call blocked.");
        const call: ToolCall = { toolName: event.toolName, input: event.input };
        const mode = options.getMode();
        const verdict = policy(mode, call, {
          cwd: ctx.cwd,
          planFilePath: path.join(ctx.cwd, ".pi", "plans", "permission-modes.md"),
          rules: options.rules ?? {},
          bypassEnabled: options.isBypassEnabled(),
        });

        if (!verdict || !["allow", "ask", "deny"].includes(verdict.action)) {
          return blocked("Permission policy returned an invalid result; tool call blocked.");
        }
        if (verdict.action === "allow") return undefined;
        if (verdict.action === "deny") return blocked(verdictReason(verdict));

        const key = sessionApprovalKey(call, ctx.cwd);
        if (key && sessionApprovals.has(key)) return undefined;
        if (!ctx.hasUI) {
          return blocked(`Approval is required but no interactive UI is available: ${verdictReason(verdict)}`);
        }

        let selection: string | undefined;
        try {
          selection = await ctx.ui.select(
            `Permission required for ${call.toolName}: ${verdictReason(verdict)}`,
            [ALLOW_ONCE, ALLOW_SESSION, DENY],
          );
        } catch {
          return blocked("The approval dialog failed; tool call blocked.");
        }

        if (selection === ALLOW_ONCE) return undefined;
        if (selection === ALLOW_SESSION) {
          if (!key) return blocked("Could not safely record an exact session approval; tool call blocked.");
          sessionApprovals.add(key);
          return undefined;
        }
        return blocked("Tool call denied by the user or approval dialog cancelled.");
      } catch {
        return blocked("Permission policy failed; tool call blocked.");
      }
    },
  };
}

export function registerPermissionModes(pi: ExtensionAPI): void {
  let mode: PermissionMode = "default";
  let bypassEnabled = false;
  const toolHandler = createToolCallHandler({
    getMode: () => mode,
    isBypassEnabled: () => bypassEnabled,
  });

  const setStatus = (ctx: ExtensionContext) => {
    ctx.ui.setStatus(STATUS_KEY, MODE_INFO[mode].badge);
  };
  const notify = (ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info") => {
    try {
      ctx.ui.notify(message, type);
    } catch {
      // Status and permission decisions do not depend on notifications succeeding.
    }
  };

  const switchMode = async (next: PermissionMode, ctx: ExtensionContext): Promise<boolean> => {
    if (next === mode) {
      notify(ctx, `Permission mode is already ${MODE_INFO[mode].badge} (${mode}).`);
      return true;
    }
    if (next === "bypassPermissions") {
      if (!bypassEnabled) {
        notify(ctx, "bypassPermissions is unavailable: start Pi with --permission-mode bypassPermissions to enable it.", "warning");
        return false;
      }
      if (!ctx.hasUI) {
        notify(ctx, "bypassPermissions cannot be enabled without an interactive confirmation UI.", "warning");
        return false;
      }
      let confirmed = false;
      try {
        confirmed = await ctx.ui.confirm(
          "Enable bypassPermissions?",
          "This allows all calls except policy hard-denies for the rest of this session.",
        );
      } catch {
        notify(ctx, "The bypass confirmation failed; the mode was not changed.", "error");
        return false;
      }
      if (!confirmed) {
        notify(ctx, "bypassPermissions was not enabled.", "warning");
        return false;
      }
    }

    try {
      persistMode(next, (customType, data) => pi.appendEntry(customType, data));
    } catch {
      notify(ctx, "Could not persist the permission mode; the mode was not changed.", "error");
      return false;
    }
    mode = next;
    setStatus(ctx);
    notify(ctx, `Permission mode set to ${MODE_INFO[mode].badge} (${mode}).`);
    return true;
  };

  pi.registerFlag("permission-mode", {
    description: "Start in default, acceptEdits, or gated bypassPermissions mode",
    type: "string",
  });

  pi.on("session_start", (_event, ctx) => {
    const rawFlag = pi.getFlag("permission-mode");
    const cliMode = rawFlag === undefined ? undefined : String(rawFlag);
    bypassEnabled = cliMode === "bypassPermissions";
    let restoredMode: PermissionMode | undefined;
    try {
      restoredMode = restoreMode(ctx.sessionManager.getBranch());
    } catch {
      restoredMode = undefined;
      notify(ctx, "Could not restore the saved permission mode; using default mode.", "warning");
    }
    const resolved = resolveInitialMode(cliMode, restoredMode, bypassEnabled);
    mode = resolved.mode;
    toolHandler.clearSessionApprovals();
    setStatus(ctx);
    if (resolved.invalidCliMode) {
      notify(ctx, `Unsupported permission mode "${cliMode}"; using default mode.`, "warning");
    }
    if (resolved.bypassFallback) {
      notify(ctx, "Saved bypassPermissions mode was ignored. Start with --permission-mode bypassPermissions to enable bypass.", "warning");
    }
  });

  pi.on("tool_call", (event: ToolCallEvent, ctx) => toolHandler.handle(event, ctx));

  pi.registerCommand("mode", {
    description: "Show or change the permission mode",
    getArgumentCompletions: (prefix) => PERMISSION_MODES
      .filter((candidate) => candidate.startsWith(prefix))
      .map((candidate) => ({
        value: candidate,
        label: candidate,
        description: candidate === "bypassPermissions" && !bypassEnabled
          ? "Requires --permission-mode bypassPermissions"
          : MODE_INFO[candidate].description,
      })),
    handler: async (args, ctx) => {
      const requested = args.trim();
      if (!requested) {
        notify(ctx, `Current permission mode: ${MODE_INFO[mode].badge} (${mode})\n${formatModeList(mode)}`);
        return;
      }
      if (!isPermissionMode(requested)) {
        notify(ctx, `Unsupported mode "${requested}". Available modes: ${PERMISSION_MODES.join(", ")}.`, "warning");
        return;
      }
      await switchMode(requested, ctx);
    },
  });

  pi.registerShortcut("alt+m", {
    description: "Cycle default and acceptEdits permission modes",
    handler: async (ctx) => {
      await switchMode(nextCycleMode(mode), ctx);
    },
  });
}

export default registerPermissionModes;
