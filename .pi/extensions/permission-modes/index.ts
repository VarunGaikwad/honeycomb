import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { lstatSync, readFileSync } from "node:fs";
import { Type } from "typebox";
import { PlanStore } from "./plan-storage.ts";
import { decide, type Mode as PolicyMode, type PolicyCtx, type ToolCall, type Verdict } from "./policy.ts";
import { normalizeBashCommand, type Rules } from "./rules.ts";
import { resolveReal } from "./paths.ts";
import { formatModeList, isPermissionMode, MODE_INFO, nextCycleMode, PERMISSION_MODES, type PermissionMode } from "./modes.ts";
import { persistMode, resolveInitialMode, restoreMode, restorePlanTools } from "./state.ts";
import { planDecision, PLAN_APPROVAL_OPTIONS } from "./plan-approval.ts";

const STATUS_KEY = "permission-modes";
const ALLOW_ONCE = "Allow once";
const ALLOW_SESSION = "Allow for this session";
const DENY = "Deny";
const PLAN_READ_TOOLS = new Set(["read", "grep", "find", "ls"]);

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
  isTrustedPlanReadTool?: (name: string) => boolean;
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
        if (mode === "plan" && PLAN_READ_TOOLS.has(call.toolName) && !options.isTrustedPlanReadTool?.(call.toolName)) {
          return blocked("Plan mode cannot verify that this read tool is a trusted Pi built-in.");
        }
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
  let previousTools: string[] | undefined;
  let sessionGeneration = 0;
  let approvalOpen = false;
  const plans = new PlanStore();
  let savedContent: string | undefined;
  pi.registerTool({
    name: "save_plan",
    label: "Save plan",
    description: "Save a new plan revision during plan mode. Saving is not approval.",
    parameters: Type.Object({ content: Type.String() }, { additionalProperties: false }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (mode !== "plan") throw new Error("save_plan is only available in plan mode");
      if (!params || typeof params.content !== "string" || Object.keys(params).some((key) => key !== "content")) {
        throw new Error("Only plan content is accepted");
      }
      const saved = plans.save(ctx.cwd, params.content, signal);
      savedContent = params.content;
      return { content: [{ type: "text", text: `Plan saved: ${saved}. This does not approve implementation.` }], details: { path: saved } };
    },
  });
  const isTrustedPlanReadTool = (name: string) => {
    if (!PLAN_READ_TOOLS.has(name)) return false;
    const matches = pi.getAllTools().filter((tool) => tool.name === name);
    return matches.length === 1 && matches[0]!.sourceInfo.source === "builtin" &&
      matches[0]!.sourceInfo.path === `builtin:${name}`;
  };
  const restrictTools = (tools: readonly string[]) => pi.setActiveTools([...tools.filter(isTrustedPlanReadTool), "save_plan"]);
  const toolHandler = createToolCallHandler({
    getMode: () => mode,
    isBypassEnabled: () => bypassEnabled,
    isTrustedPlanReadTool,
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

    if (next === "plan") {
      let snapshot: string[];
      try {
        snapshot = pi.getActiveTools();
        persistMode(next, (customType, data) => pi.appendEntry(customType, data), snapshot);
      } catch {
        notify(ctx, "Could not save the previous tool configuration; plan mode was not entered.", "error");
        return false;
      }
      previousTools = [...snapshot];
      plans.clear();
      savedContent = undefined;
      mode = "plan"; // Enforce the hook even if filtering fails.
      try {
        restrictTools(snapshot);
      } catch {
        notify(ctx, "Tool filtering failed; plan policy remains active and blocks untrusted calls.", "error");
      }
    } else if (mode === "plan") {
      if (!previousTools) {
        notify(ctx, "Previous tools are unavailable; refusing to leave plan mode.", "error");
        return false;
      }
      try {
        pi.setActiveTools(previousTools);
        persistMode(next, (customType, data) => pi.appendEntry(customType, data));
      } catch {
        try { restrictTools(previousTools); } catch { /* The plan hook remains active. */ }
        notify(ctx, "Could not restore tools and persist the mode; plan mode remains active.", "error");
        return false;
      }
      previousTools = undefined;
      mode = next;
    } else {
      try {
        persistMode(next, (customType, data) => pi.appendEntry(customType, data));
      } catch {
        notify(ctx, "Could not persist the permission mode; the mode was not changed.", "error");
        return false;
      }
      mode = next;
    }
    sessionGeneration++;
    approvalOpen = false;
    setStatus(ctx);
    notify(ctx, `Permission mode set to ${MODE_INFO[mode].badge} (${mode}).`);
    return true;
  };

  pi.registerFlag("permission-mode", {
    description: "Start in default, acceptEdits, plan, or gated bypassPermissions mode",
    type: "string",
  });

  const restoreSession = (ctx: ExtensionContext) => {
    const rawFlag = pi.getFlag("permission-mode");
    const cliMode = rawFlag === undefined ? undefined : String(rawFlag);
    bypassEnabled = cliMode === "bypassPermissions";
    let restoredMode: PermissionMode | undefined;
    let savedTools: string[] | undefined;
    try {
      const branch = ctx.sessionManager.getBranch();
      restoredMode = restoreMode(branch);
      savedTools = restorePlanTools(branch);
    } catch {
      notify(ctx, "Could not restore the saved permission mode; using default mode.", "warning");
    }
    const resolved = resolveInitialMode(cliMode, restoredMode, bypassEnabled);
    sessionGeneration++;
    approvalOpen = false;
    plans.clear();
    savedContent = undefined;
    toolHandler.clearSessionApprovals();
    // A reload may retain the filtered active list; restore the saved snapshot
    // before applying a CLI override away from plan mode.
    const priorSnapshot = previousTools ?? (restoredMode === "plan" ? savedTools : undefined);
    if (priorSnapshot) {
      try { pi.setActiveTools(priorSnapshot); } catch {
        mode = "plan";
        previousTools = priorSnapshot;
        notify(ctx, "Could not restore tools; remaining in plan mode.", "error");
        setStatus(ctx);
        return;
      }
    }
    mode = resolved.mode;
    previousTools = undefined;
    if (mode === "plan") {
      try {
        previousTools = savedTools ?? (restoredMode === "plan" ? undefined : pi.getActiveTools());
        if (previousTools && restoredMode !== "plan") {
          persistMode("plan", (customType, data) => pi.appendEntry(customType, data), previousTools);
        }
      } catch {
        notify(ctx, "Could not persist the plan tool snapshot; restoration after reload may be unavailable.", "error");
      }
      try {
        restrictTools(pi.getActiveTools());
      } catch {
        notify(ctx, "Could not restore plan tool filtering; the plan policy remains active.", "error");
      }
    }
    setStatus(ctx);
    if (resolved.invalidCliMode) {
      notify(ctx, `Unsupported permission mode "${cliMode}"; using default mode.`, "warning");
    }
    if (resolved.bypassFallback) {
      notify(ctx, "Saved bypassPermissions mode was ignored. Start with --permission-mode bypassPermissions to enable bypass.", "warning");
    }
  };
  pi.on("session_start", (_event, ctx) => restoreSession(ctx));
  pi.on("session_tree", (_event, ctx) => restoreSession(ctx));

  pi.on("tool_call", (event: ToolCallEvent, ctx) => toolHandler.handle(event, ctx));

  pi.on("before_agent_start", (event) => {
    if (mode !== "plan") return;
    return { systemPrompt: `${event.systemPrompt}\n\nYou are in PLAN mode. Explore using trusted read-only tools only. ` +
      "Do not execute commands or modify files. Present a numbered implementation plan in your response. " +
      "Use save_plan to save the plan. Saving does not grant approval; do not start implementation." };
  });

  pi.on("agent_settled", async (event, ctx) => {
    if (mode !== "plan" || event.aborted || !ctx.hasUI || approvalOpen) return;
    const generation = sessionGeneration;
    approvalOpen = true;
    try {
      const snapshot = plans.latest;
      const content = savedContent;
      const selection = await ctx.ui.select("Review the latest saved plan", [...PLAN_APPROVAL_OPTIONS]);
      if (generation !== sessionGeneration || mode !== "plan" || snapshot !== plans.latest || content !== savedContent) return;
      const decision = planDecision(selection);
      if (decision === "discard") {
        plans.clear();
        savedContent = undefined;
        await switchMode("default", ctx);
      } else if (decision === "acceptEdits" || decision === "default") {
        if (!snapshot || content === undefined || content.trim().length === 0) {
          notify(ctx, "A nonempty saved plan is required before approval.", "warning");
          return;
        }
        try {
          for (const component of [path.join(ctx.cwd, ".pi"), path.join(ctx.cwd, ".pi", "plans"), snapshot]) {
            const stat = lstatSync(component);
            if (stat.isSymbolicLink() || (component === snapshot ? !stat.isFile() : !stat.isDirectory())) throw new Error("Unsafe plan path");
          }
          if (readFileSync(snapshot, "utf8") !== content) throw new Error("Plan content changed");
        } catch {
          notify(ctx, "Saved plan is missing or invalid; approval was not applied.", "error");
          return;
        }
        // Consume the approval before the single handoff attempt; never retry implicitly.
        plans.clear();
        savedContent = undefined;
        if (!await switchMode(decision, ctx)) return;
        // switchMode is async for bypass confirmation; guard the handoff boundary
        // against a session or mode change while its promise settles.
        if (sessionGeneration !== generation + 1 || (mode as PermissionMode) !== decision) return;
        try {
          pi.sendUserMessage(`Implement the following approved plan:\n\n${content}`);
        } catch {
          notify(ctx, "Implementation handoff failed. Approval was consumed; review and approve a plan again to retry.", "error");
        }
      }
    } catch {
      notify(ctx, "Plan decision was cancelled or failed; continuing in plan mode.", "warning");
    } finally {
      if (generation === sessionGeneration) approvalOpen = false;
    }
  });

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
    description: "Cycle default, acceptEdits, and plan permission modes",
    handler: async (ctx) => {
      await switchMode(nextCycleMode(mode), ctx);
    },
  });
}

export default registerPermissionModes;
