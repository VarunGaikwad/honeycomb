import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { fileURLToPath } from 'node:url';
import { createPermissionPrompter } from '../../tui/permission-dialog.ts';
import { registerPermissionRules, type PermissionActivity } from '../../tui/permission-rules.ts';
import { decidePermission } from './policy.ts';
import { loadPermissionRules } from './rules.ts';
import { isMcpResourceTool, MCP_RESOURCE_SERVER_FLAG, validMcpServerName } from './mcp-resources.ts';
import { MODE_ENTRY, restorePermissionMode } from './state.ts';
import { discardPlanNote, MAX_PLAN_BYTES, planNotePath, readPlanNote, writePlanNote } from './plan-note.ts';
import { previewToolCall } from './preview.ts';
import { classifyShell } from './shell.ts';
import { resolvePermissionPath } from './paths.ts';
import { readGoalState } from '../../commands/goal/state.ts';
import { selectedLspServer } from '../lsp-menu.ts';
import { WEB_FETCH_FLAG } from '../../tools/web-fetch.ts';
import { getTavilyKey, WEB_SEARCH_FLAG, webSearchSetupTip } from '../../tools/web-search.ts';

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions';
const cycle: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto'];
const labels: Record<PermissionMode, string> = { default: 'Manual', acceptEdits: 'Edits', plan: 'Plan', auto: 'Auto', dontAsk: 'No prompts', bypassPermissions: 'Bypass' };
const planTools = new Set(['read', 'ls', 'grep', 'find', 'glob', 'git_status', 'git_diff', 'git_log', 'git_branch', 'goal_report', 'todo', 'plan', 'ask_user', 'plan_note']);
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

function approvalKey(cwd: string, tool: string, args: Record<string, unknown>): string {
  const paths: unknown[] = [args.path, args.source, args.destination];
  if (tool === 'apply_patch' && Array.isArray(args.edits)) {
    for (const edit of args.edits) if (edit && typeof edit === 'object') paths.push(edit.path);
  }
  if (['ls', 'grep', 'find', 'glob'].includes(tool) && args.path === undefined) paths.push('.');
  if (['bash', 'background', 'terminal'].includes(tool) && typeof args.command === 'string') {
    const shell = classifyShell(args.command, cwd);
    if (shell.kind === 'read') paths.push(...shell.paths);
  }
  const resolved = paths.filter((target): target is string => typeof target === 'string').map(target => resolvePermissionPath(cwd, target));
  return JSON.stringify(canonical([cwd, tool, args, resolved]));
}

export type PermissionReviewer = (summary: { tool: 'bash'; operation: 'pwd' }) => Promise<'allow' | 'deny' | 'ask'>;
export function createPermissionModes(pi: ExtensionAPI, options: { reviewer?: PermissionReviewer; reviewerTimeoutMs?: number } = {}) {
  let mode: PermissionMode = 'default';
  let launchMode: string | undefined;
  let bypassConfirmed = false;
  let priorTools: string[] | undefined;
  let pendingPlan: string | undefined;
  let epoch = 0;
  let turnDeclines = 0, sessionDeclines = 0;
  const listeners = new Set<() => void>();
  const approvals = new Set<string>();
  const commitApprovals = new Map<string, (ctx: ExtensionContext, args: Record<string, unknown>, tool: string, server?: string) => boolean>();
  const denials: PermissionActivity[] = [];
  const prompter = createPermissionPrompter();
  const block = (tool: string, reason: string) => {
    denials.unshift({ tool, reason });
    if (denials.length > 20) denials.pop();
    return { block: true as const, reason };
  };
  pi.registerFlag?.('permission-mode', { description: 'Permission mode (default, acceptEdits, plan, auto, dontAsk, bypassPermissions)', type: 'string' });
  pi.registerFlag?.(MCP_RESOURCE_SERVER_FLAG, { type: 'string', description: 'Allow prompts for Pi MCP resource calls to one configured server by name' });
  const allowed = (value: string): value is PermissionMode => cycle.includes(value as PermissionMode) ||
    (value === 'dontAsk' && launchMode === value) || (value === 'bypassPermissions' && launchMode === value && bypassConfirmed);
  const change = (next: PermissionMode, persist = true) => {
    if (!allowed(next)) return false;
    if (mode !== 'plan' && next === 'plan' && pi.getActiveTools && pi.setActiveTools) {
      priorTools = pi.getActiveTools().filter(name => name !== 'plan_note');
      pi.setActiveTools([...priorTools.filter(name => planTools.has(name)), 'plan_note']);
    } else if (mode === 'plan' && next !== 'plan' && priorTools && pi.setActiveTools) {
      pi.setActiveTools(priorTools); priorTools = undefined;
    }
    mode = next;
    epoch++;
    approvals.clear();
    commitApprovals.clear();
    if (next !== 'plan') pendingPlan = undefined;
    if (persist) pi.appendEntry?.(MODE_ENTRY, { mode: next });
    for (const fn of listeners) fn();
    return true;
  };
  const cycleMode = () => { change(cycle[(cycle.indexOf(mode) + 1) % cycle.length]!); };
  registerPermissionRules(pi, () => ({ mode: labels[mode], approvals: approvals.size, denials }));
  pi.registerTool?.({
    name: 'plan_note', label: 'Plan note', description: 'Write the current session plan note in Plan mode.',
    defaultActive: false,
    executionMode: 'sequential',
    parameters: Type.Object({ content: Type.String({ maxLength: MAX_PLAN_BYTES }) }),
    async execute(_id, args, signal, _update, ctx) {
      if (mode !== 'plan') throw new Error('Plan note is available only in Plan mode');
      const started = epoch;
      const sessionId = ctx.sessionManager.getSessionId();
      const previous = await readPlanNote(ctx.cwd, sessionId);
      if (started !== epoch || signal?.aborted) throw new Error('Plan note write was cancelled');
      const file = await writePlanNote(ctx.cwd, sessionId, args.content);
      if (started === epoch && previous !== args.content) pendingPlan = args.content;
      return { content: [{ type: 'text', text: `Plan saved to ${file}` }], details: {} };
    },
  });
  pi.on('session_start', async (event, ctx) => {
    epoch++;
    commitApprovals.clear();
    approvals.clear(); denials.length = 0; pendingPlan = undefined; priorTools = undefined; mode = 'default'; turnDeclines = 0; sessionDeclines = 0;
    launchMode = pi.getFlag?.('permission-mode') as string | undefined;
    bypassConfirmed = false;
    if (launchMode && ![...cycle, 'dontAsk', 'bypassPermissions'].includes(launchMode as PermissionMode)) throw new Error(`Invalid permission mode: ${launchMode}`);
    if (launchMode === 'bypassPermissions') {
      if (!ctx.hasUI) throw new Error('Bypass mode requires interactive confirmation');
      bypassConfirmed = await prompter.confirm(ctx, 'Enable Bypass mode?', 'Routine mode prompts will be skipped; existing safety checks still apply.');
      if (!bypassConfirmed) {
        launchMode = undefined;
        ctx.ui.notify('Bypass was not enabled. Staying in Manual mode.', 'warning');
        change('default');
        return;
      }
    }
    const restored = restorePermissionMode(ctx.sessionManager?.getBranch?.() ?? []);
    const config = loadPermissionRules(ctx.cwd, message => { if (ctx.hasUI) ctx.ui.notify(message, 'warning'); else console.warn(message); });
    const saved = restored && allowed(restored) ? restored : undefined;
    const next = (event.reason === 'reload' ? saved ?? launchMode : launchMode ?? saved) ?? config.defaultMode ?? 'default';
    change(allowed(next) ? next : 'default', next !== saved);
  });
  pi.on('session_shutdown', event => {
    epoch++;
    approvals.clear();
    commitApprovals.clear();
    // Pi snapshots the active tools after shutdown when rebuilding on reload.
    if (event.reason === 'reload' && mode === 'plan' && priorTools) pi.setActiveTools(priorTools);
  });
  pi.on('session_tree', (_event, ctx) => {
    approvals.clear(); denials.length = 0; pendingPlan = undefined;
    const restored = restorePermissionMode(ctx?.sessionManager?.getBranch?.() ?? []);
    const config = ctx?.cwd ? loadPermissionRules(ctx.cwd, message => { if (ctx.hasUI) ctx.ui.notify(message, 'warning'); else console.warn(message); }) : undefined;
    const next = restored && allowed(restored) ? restored : launchMode && allowed(launchMode) ? launchMode : config?.defaultMode;
    change(next && allowed(next) ? next : 'default', false);
  });
  pi.registerShortcut('alt+m', { description: 'Cycle permission mode', handler: cycleMode });
  pi.on('agent_start', () => { turnDeclines = 0; });
  pi.on('turn_start', () => { turnDeclines = 0; });
  pi.on('turn_end', () => { commitApprovals.clear(); });
  const decline = () => {
    if (mode !== 'auto') return;
    turnDeclines++; sessionDeclines++;
    if (turnDeclines >= 3 || sessionDeclines >= 20) change('default');
  };
  pi.on('agent_before_settle', async (event, ctx) => {
    if (mode !== 'plan' || pendingPlan === undefined || event.outcome !== 'completed' || !ctx.hasUI) return;
    const started = epoch;
    const content = pendingPlan;
    pendingPlan = undefined;
    try {
      const session = ctx.sessionManager.getSessionId();
      const file = planNotePath(ctx.cwd, session);
      if (await readPlanNote(ctx.cwd, session) !== content || started !== epoch) return;
      const choice = await prompter.choose(ctx, {
        title: 'Ready to implement?',
        preview: [{ text: file, color: 'dim' }, { text: content }],
        options: [
          { value: 'Start in Edits', label: 'Yes, start in Edits mode' },
          { value: 'Start in Manual', label: 'Yes, ask before edits' },
          { value: 'Keep planning', label: 'No, keep planning' },
          { value: 'Discard the note' },
        ],
        initial: 'Keep planning',
      });
      if (!choice || started !== epoch || ctx.signal?.aborted) return;
      if (await readPlanNote(ctx.cwd, session) !== content || started !== epoch || ctx.signal?.aborted) {
        ctx.ui.notify('The plan changed during review. It was not approved.', 'warning');
        return;
      }
      const next = choice === 'Start in Edits' ? 'acceptEdits' : choice === 'Start in Manual' ? 'default' : undefined;
      if (next) {
        change(next, false);
        const entries = [...event.entries, { type: 'custom' as const, customType: MODE_ENTRY, data: { mode: next } }];
        const goal = readGoalState([...ctx.sessionManager.getBranch(), ...entries]);
        if (goal?.status === 'active' || event.continue || event.context?.pendingMessages?.length || ctx.hasPendingMessages?.()) return { entries };
        return { entries: [...entries, { type: 'custom_message' as const, customType: 'bi.plan-approval', content: `The plan in ${file} was approved. Implement it now.`, display: false }], continue: true };
      }
      else if (choice === 'Discard the note') await discardPlanNote(ctx.cwd, session);
    } catch { /* Dismissal and UI errors leave Plan active. */ }
  });
  pi.on('tool_call', async (event, ctx) => {
    const { toolName, input, toolCallId } = event;
    const isCommit = toolName === 'git_commit';
    const combinedGit = isCommit || toolName === 'git_add' || toolName === 'git_checkout' || (toolName === 'git_branch' && typeof (input as Record<string, unknown>).name === 'string');
    const webFetch = toolName === 'web_fetch';
    const webSearch = toolName === 'web_search';
    const combined = (combinedGit || webSearch || ['bash', 'background', 'terminal', 'run_code', 'delete', 'notebook_edit', 'lsp', 'web_fetch'].includes(toolName)) && typeof ctx.sessionManager?.getSessionId === 'function';
    if (combined) commitApprovals.delete(toolCallId);
    const started = epoch;
    const args = input as Record<string, unknown>;
    const deny = (reason: string) => block(toolName, reason);
    const mcpResource = isMcpResourceTool(toolName);
    const mcpResourceEnabled = () => {
      const server = pi.getFlag?.(MCP_RESOURCE_SERVER_FLAG);
      return ctx.hasUI && ctx.isProjectTrusted?.() && validMcpServerName(server) && args?.server === server;
    };
    if (mcpResource && !mcpResourceEnabled()) return deny('MCP resources require an interactive trusted project and an explicit server matching --bi-mcp-resource-server.');
    const webFetchEnabled = () => ctx.hasUI && ctx.isProjectTrusted?.() && pi.getFlag?.(WEB_FETCH_FLAG) === true && pi.getActiveTools().includes('web_fetch');
    if (webFetch && (!combined || !webFetchEnabled())) return deny('Web fetch requires launch opt-in and an interactive trusted project.');
    if (webSearch && !getTavilyKey()) return deny(webSearchSetupTip);
    const webSearchEnabled = () => ctx.hasUI && ctx.isProjectTrusted?.() && !!getTavilyKey() &&
      pi.getFlag?.(WEB_SEARCH_FLAG) === true && pi.getActiveTools().includes('web_search');
    if (webSearch && (!combined || !webSearchEnabled())) return deny('Web search requires launch opt-in and an interactive trusted project.');
    const load = () => loadPermissionRules(ctx.cwd, message => { if (ctx.hasUI) ctx.ui.notify(message, 'warning'); else console.warn(message); });
    const loaded = load();
    if (loaded.invalid) return deny('Invalid permission configuration; correct it before running tools.');
    const decision = decidePermission(mode, toolName, input, ctx.cwd, loaded.rules);
    if (decision.action === 'deny') return deny(decision.reason);
    if (decision.action === 'allow') return undefined;
    // Only Bi's own undo handler performs a target-aware confirmation after preflight.
    // Other extensions' tools must continue through the normal gate.
    if (toolName === 'undo' && mode !== 'dontAsk' && ctx.hasUI && !ctx.signal?.aborted) {
      const registered = pi.getAllTools?.().find(tool => tool.name === 'undo');
      if (registered?.sourceInfo.path === fileURLToPath(new URL('../../index.ts', import.meta.url))) return undefined;
    }
    const stillCurrent = () => started === epoch && !ctx.signal?.aborted;
    const recheck = (currentInput = input) => {
      const current = load();
      if (current.invalid) return false;
      const updated = decidePermission(mode, toolName, currentInput, ctx.cwd, current.rules);
      return updated.action !== 'deny' && updated.source === decision.source && updated.reason === decision.reason;
    };
    // Only summarize a call when no operands, secrets, file contents or output are sent.
    if (mode === 'auto' && decision.source === 'default' && options.reviewer && toolName === 'bash' && typeof args.command === 'string') {
      const command = args.command;
      const shell = classifyShell(command, ctx.cwd);
      if (shell.kind === 'read' && shell.paths.length === 0 && command.trim() === 'pwd') {
        let timer: number | undefined;
        try {
          const reviewed = await Promise.race([
            options.reviewer({ tool: 'bash', operation: 'pwd' }),
            new Promise<undefined>(resolve => { timer = setTimeout(resolve, options.reviewerTimeoutMs ?? 15_000); }),
          ]);
          if (!stillCurrent()) return deny('Permission context changed while reviewing.');
          if (reviewed === 'allow') return recheck() && args.command === command ? undefined : deny('Permission context changed while reviewing.');
          if (reviewed === 'deny') { decline(); return deny('Reviewer declined permission.'); }
        } catch { /* Timeout and reviewer failures fall back to the user. */ }
        finally { if (timer) clearTimeout(timer); }
      }
    }
    if (!stillCurrent()) return deny('Permission context changed before approval.');
    if (mode === 'dontAsk' || !ctx.hasUI) return deny('Permission requires an interactive confirmation.');
    const canSave = decision.source === 'default' && ['write', 'edit', 'mkdir', 'copy', 'move', 'apply_patch'].includes(toolName);
    try {
      const server = toolName === 'lsp' && ctx.isProjectTrusted?.() ? await selectedLspServer(pi, ctx.cwd) : undefined;
      if (toolName === 'lsp' && (!server || !stillCurrent())) return deny('LSP requires a trusted project and an explicitly configured server.');
      const key = approvalKey(ctx.cwd, toolName, args);
      if (canSave && approvals.has(key)) return undefined;
      const { title, preview } = previewToolCall(toolName, args);
      const sessionId = combined ? ctx.sessionManager.getSessionId() : undefined;
      const allowOnce = isCommit ? 'Yes, commit once' : 'Allow once';
      const selected = await prompter.choose(ctx, {
        title,
        preview: [{ text: decision.reason, color: 'dim' }, ...(server ? [{ text: `Server: ${server} --stdio` }] : []), ...preview],
        options: [
          { value: allowOnce, label: isCommit ? allowOnce : 'Yes, allow once' },
          ...(canSave ? [{ value: 'Allow exact call for session', label: 'Yes, exact call for this session' }] : []),
          { value: 'Deny', label: 'No' },
        ],
        initial: 'Deny',
      });
      if (selected === allowOnce || (selected === 'Allow exact call for session' && canSave)) {
        if (!stillCurrent() || !recheck() || approvalKey(ctx.cwd, toolName, args) !== key ||
            (server && !ctx.isProjectTrusted?.()) || (webFetch && !webFetchEnabled()) || (webSearch && !webSearchEnabled()) ||
            (mcpResource && !mcpResourceEnabled())) return deny('Permission context changed while waiting for approval.');
        if (combined) {
          // The prompt authorizes only this exact tool call.
          commitApprovals.set(toolCallId, (executionCtx, executionArgs, executionTool, executionServer) =>
            executionTool === toolName && executionServer === server && executionCtx.sessionManager.getSessionId() === sessionId && stillCurrent() && recheck(executionArgs) &&
            approvalKey(executionCtx.cwd, toolName, executionArgs) === key);
        }
        if (selected === 'Allow exact call for session') approvals.add(key);
        return undefined;
      }
    } catch { return deny('Unable to identify tool call safely.'); }
    if (stillCurrent()) decline();
    return deny('Permission declined.');
  });
  return {
    get mode() { return mode; },
    get label() { return labels[mode]; },
    cycle: cycleMode,
    enterPlan(): boolean {
      if (!['default', 'acceptEdits', 'auto', 'plan'].includes(mode)) return false;
      if (mode === 'plan') return true;
      if (!pi.getActiveTools || !pi.setActiveTools) return false;
      return change('plan');
    },
    prompter,
    consumeCommitApproval(id: string, ctx: ExtensionContext, args: Record<string, unknown>, tool = 'git_commit', server?: string): boolean | undefined {
      const approval = commitApprovals.get(id);
      commitApprovals.delete(id);
      if (!ctx.hasUI || ctx.signal?.aborted) return false;
      try {
        if (approval) return approval(ctx, args, tool, server);
        const loaded = loadPermissionRules(ctx.cwd, () => {});
        // An allow decision can skip the gate, but not the Git tool's confirmation.
        if (!loaded.invalid && decidePermission(mode, tool, args, ctx.cwd, loaded.rules).action === 'allow') return undefined;
      } catch { /* An invalid or stale approval cannot authorize a commit. */ }
      return false;
    },
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
}
export type PermissionController = ReturnType<typeof createPermissionModes>;
