import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { readFile } from 'node:fs/promises';
import { Type } from 'typebox';
import { decidePermission } from './policy.ts';
import { loadPermissionRules } from './rules.ts';
import { MODE_ENTRY, restorePermissionMode } from './state.ts';
import { discardPlanNote, planNotePath, writePlanNote } from './plan-note.ts';
import { classifyShell } from './shell.ts';
import { readGoalState } from '../../commands/goal/state.ts';

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions';
const cycle: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto'];
const labels: Record<PermissionMode, string> = { default: 'Manual', acceptEdits: 'Edits', plan: 'Plan', auto: 'Auto', dontAsk: 'No prompts', bypassPermissions: 'Bypass' };
const planTools = new Set(['read', 'ls', 'grep', 'find', 'git_status', 'git_diff', 'git_log', 'git_branch', 'goal_report', 'todo', 'plan', 'ask_user', 'plan_note']);
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

export type PermissionReviewer = (summary: { tool: 'bash'; operation: 'pwd' }) => Promise<'allow' | 'deny' | 'ask'>;
export function createPermissionModes(pi: ExtensionAPI, options: { reviewer?: PermissionReviewer; reviewerTimeoutMs?: number } = {}) {
  let mode: PermissionMode = 'default';
  let launchMode: string | undefined;
  let bypassConfirmed = false;
  let priorTools: string[] | undefined;
  let noteChanged = false;
  let turnDeclines = 0, sessionDeclines = 0;
  const listeners = new Set<() => void>();
  const approvals = new Set<string>();
  pi.registerFlag?.('permission-mode', { description: 'Permission mode (default, acceptEdits, plan, auto, dontAsk, bypassPermissions)', type: 'string' });
  const allowed = (value: string): value is PermissionMode => cycle.includes(value as PermissionMode) ||
    (value === 'dontAsk' && launchMode === value) || (value === 'bypassPermissions' && launchMode === value && bypassConfirmed);
  const change = (next: PermissionMode, persist = true) => {
    if (!allowed(next)) return false;
    if (mode !== 'plan' && next === 'plan' && pi.getActiveTools && pi.setActiveTools) {
      priorTools = pi.getActiveTools();
      pi.setActiveTools([...priorTools.filter(name => planTools.has(name)), 'plan_note']);
    } else if (mode === 'plan' && next !== 'plan' && priorTools && pi.setActiveTools) {
      pi.setActiveTools(priorTools); priorTools = undefined;
    }
    mode = next; approvals.clear();
    if (persist) pi.appendEntry?.(MODE_ENTRY, { mode: next });
    for (const fn of listeners) fn();
    return true;
  };
  pi.registerTool?.({
    name: 'plan_note', label: 'Plan note', description: 'Write the current session plan note in Plan mode.',
    defaultActive: false,
    parameters: Type.Object({ content: Type.String() }),
    async execute(_id, args, _signal, _update, ctx) {
      if (mode !== 'plan') throw new Error('Plan note is available only in Plan mode');
      const sessionId = ctx.sessionManager.getSessionId();
      const previous = await readFile(planNotePath(ctx.cwd, sessionId), 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
      const file = await writePlanNote(ctx.cwd, sessionId, args.content);
      if (previous !== args.content) noteChanged = true;
      return { content: [{ type: 'text', text: `Plan saved to ${file}` }], details: {} };
    },
  });
  pi.on('session_start', async (_event, ctx) => {
    approvals.clear(); noteChanged = false; priorTools = undefined; mode = 'default'; turnDeclines = 0; sessionDeclines = 0;
    launchMode = pi.getFlag?.('permission-mode') as string | undefined;
    bypassConfirmed = false;
    if (launchMode && ![...cycle, 'dontAsk', 'bypassPermissions'].includes(launchMode as PermissionMode)) throw new Error(`Invalid permission mode: ${launchMode}`);
    if (launchMode === 'bypassPermissions') {
      if (!ctx.hasUI || !await ctx.ui.confirm('Enable Bypass mode?', 'Routine mode prompts will be skipped; existing safety checks still apply.')) throw new Error('Bypass mode requires interactive confirmation');
      bypassConfirmed = true;
    }
    const restored = restorePermissionMode(ctx.sessionManager?.getBranch?.() ?? []);
    const config = loadPermissionRules(ctx.cwd, message => { if (ctx.hasUI) ctx.ui.notify(message, 'warning'); else console.warn(message); });
    const next = launchMode ?? (restored && allowed(restored) ? restored : undefined) ?? config.defaultMode ?? 'default';
    change(allowed(next) ? next : 'default', !!launchMode || !restored || !allowed(restored));
  });
  pi.on('session_shutdown', () => { approvals.clear(); });
  pi.on('session_tree', (_event, ctx) => {
    approvals.clear(); noteChanged = false;
    const restored = restorePermissionMode(ctx?.sessionManager?.getBranch?.() ?? []);
    const config = ctx?.cwd ? loadPermissionRules(ctx.cwd, message => { if (ctx.hasUI) ctx.ui.notify(message, 'warning'); else console.warn(message); }) : undefined;
    const next = launchMode && allowed(launchMode) ? launchMode : restored && allowed(restored) ? restored : config?.defaultMode;
    change(next && allowed(next) ? next : 'default', false);
  });
  pi.registerShortcut('alt+m', { description: 'Cycle permission mode', handler: () => { change(cycle[(cycle.indexOf(mode) + 1) % cycle.length]!); } });
  pi.on('agent_start', () => { turnDeclines = 0; });
  pi.on('turn_start', () => { turnDeclines = 0; });
  const decline = () => {
    if (mode !== 'auto') return;
    turnDeclines++; sessionDeclines++;
    if (turnDeclines >= 3 || sessionDeclines >= 20) change('default');
  };
  pi.on('agent_before_settle', async (event, ctx) => {
    if (mode !== 'plan' || !noteChanged || event.outcome !== 'completed' || !ctx.hasUI) return;
    noteChanged = false;
    try {
      const choice = await ctx.ui.select('Plan note updated', ['Start in Edits', 'Start in Manual', 'Keep planning', 'Discard the note']);
      const next = choice === 'Start in Edits' ? 'acceptEdits' : choice === 'Start in Manual' ? 'default' : undefined;
      if (next) {
        change(next, false);
        const entries = [...event.entries, { type: 'custom' as const, customType: MODE_ENTRY, data: { mode: next } }];
        const goal = readGoalState([...ctx.sessionManager.getBranch(), ...entries]);
        if (goal?.status === 'active' || event.continue || event.context?.pendingMessages?.length || ctx.hasPendingMessages?.()) return { entries };
        return { entries: [...entries, { type: 'custom_message' as const, customType: 'bi.plan-approval', content: `The plan in ${planNotePath(ctx.cwd, ctx.sessionManager.getSessionId())} was approved. Implement it now.`, display: false }], continue: true };
      }
      else if (choice === 'Discard the note') await discardPlanNote(ctx.cwd, ctx.sessionManager.getSessionId());
    } catch { /* Dismissal and UI errors leave Plan active. */ }
  });
  pi.on('tool_call', async (event, ctx) => {
    const loaded = loadPermissionRules(ctx.cwd, message => { if (ctx.hasUI) ctx.ui.notify(message, 'warning'); else console.warn(message); });
    if (loaded.invalid) return { block: true, reason: 'Invalid permission configuration; correct it before running tools.' };
    const decision = decidePermission(mode, event.toolName, event.input, ctx.cwd, loaded.rules);
    if (decision.action === 'deny') return { block: true, reason: decision.reason };
    if (decision.action === 'allow') return undefined;
    // Only summarize a call when no operands, secrets, file contents or output are sent.
    if (mode === 'auto' && decision.source === 'default' && options.reviewer && event.toolName === 'bash' &&
      typeof (event.input as Record<string, unknown>).command === 'string') {
      const command = (event.input as Record<string, unknown>).command as string;
      const shell = classifyShell(command, ctx.cwd);
      if (shell.kind === 'read' && shell.paths.length === 0 && command.trim() === 'pwd') {
        let timer: number | undefined;
        try {
          const reviewed = await Promise.race([
            options.reviewer({ tool: 'bash', operation: 'pwd' }),
            new Promise<undefined>(resolve => { timer = setTimeout(resolve, options.reviewerTimeoutMs ?? 15_000); }),
          ]);
          if (reviewed === 'allow') return undefined;
          if (reviewed === 'deny') { decline(); return { block: true, reason: 'Reviewer declined permission.' }; }
        } catch { /* Timeout and reviewer failures fall back to the user. */ }
        finally { if (timer) clearTimeout(timer); }
      }
    }
    if (mode === 'dontAsk' || !ctx.hasUI) return { block: true, reason: 'Permission requires an interactive confirmation.' };
    const canSave = decision.source !== 'rule' && ['write', 'edit', 'mkdir', 'copy', 'move', 'delete', 'apply_patch'].includes(event.toolName);
    let key: string;
    try { key = JSON.stringify(canonical([ctx.cwd, event.toolName, event.input])); }
    catch { return { block: true, reason: 'Unable to identify tool call safely.' }; }
    if (canSave && approvals.has(key)) return undefined;
    try {
      const options = canSave ? ['Allow once', 'Allow exact call for session', 'Deny'] : ['Allow once', 'Deny'];
      const selected = await ctx.ui.select(`Allow ${event.toolName}?\n${JSON.stringify(event.input)}`, options);
      if (selected === 'Allow once') return undefined;
      if (selected === 'Allow exact call for session' && canSave) { approvals.add(key); return undefined; }
    } catch { /* A failed dialog must not grant permission. */ }
    decline();
    return { block: true, reason: 'Permission declined.' };
  });
  return { get mode() { return mode; }, get label() { return labels[mode]; }, subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; } };
}
export type PermissionController = ReturnType<typeof createPermissionModes>;
