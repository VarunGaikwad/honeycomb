import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export const GOAL_STATE_ENTRY = 'bi.goal-state';
export const DEFAULT_GOAL_ITERATIONS = 8;
export const MAX_GOAL_ITERATIONS = 50;

export type GoalStatus = 'active' | 'paused' | 'completed' | 'blocked' | 'budget_exceeded';

export interface GoalState {
  version: 1;
  objective: string;
  status: GoalStatus;
  progress: string;
  verification?: { status: 'passed' | 'failed' | 'not_run'; summary: string };
  iteration: number;
  reportCount: number;
  maxIterations: number;
  createdAt: number;
  updatedAt: number;
}

export function readGoalState(entries: readonly unknown[]): GoalState | undefined {
  const entry = [...entries].reverse().find((candidate) => {
    if (candidate === null || typeof candidate !== 'object') return false;
    const value = candidate as { type?: unknown; customType?: unknown };
    return value.type === 'custom' && value.customType === GOAL_STATE_ENTRY;
  }) as { data?: unknown } | undefined;
  if (!entry || entry.data === null) return undefined;
  return isGoalState(entry.data) ? entry.data : undefined;
}

export function isGoalState(value: unknown): value is GoalState {
  if (value === null || typeof value !== 'object') return false;
  const state = value as Record<string, unknown>;
  return state.version === 1 &&
    typeof state.objective === 'string' &&
    ['active', 'paused', 'completed', 'blocked', 'budget_exceeded'].includes(String(state.status)) &&
    typeof state.progress === 'string' &&
    typeof state.iteration === 'number' && Number.isInteger(state.iteration) && state.iteration >= 0 &&
    typeof state.reportCount === 'number' && Number.isInteger(state.reportCount) && state.reportCount >= 0 &&
    typeof state.maxIterations === 'number' && Number.isInteger(state.maxIterations) && state.maxIterations >= 1 &&
    state.maxIterations <= MAX_GOAL_ITERATIONS &&
    typeof state.createdAt === 'number' && Number.isFinite(state.createdAt) &&
    typeof state.updatedAt === 'number' && Number.isFinite(state.updatedAt);
}

export function saveGoalState(pi: ExtensionAPI, state: GoalState): void {
  pi.appendEntry(GOAL_STATE_ENTRY, state);
}

export function saveGoalStateDraft(state: GoalState) {
  return { type: 'custom' as const, customType: GOAL_STATE_ENTRY, data: state };
}

export function goalStatusText(state: GoalState): string {
  const label = state.status.replace('_', ' ');
  const progress = state.progress ? `\nProgress: ${state.progress}` : '';
  return `Goal (${label}) — ${state.objective}\nIterations: ${state.iteration}/${state.maxIterations}${progress}`;
}

export function buildGoalPrompt(state: GoalState, firstRun = false): string {
  const context = firstRun
    ? 'Inspect the project instructions and relevant code first. Make a concise plan with concrete, verifiable acceptance criteria, then work through it step by step.'
    : `Continue from the current project state. This is automatic iteration ${Math.max(1, state.iteration)} of ${state.maxIterations}. Use this latest progress report as your checkpoint: ${state.progress || 'No progress report was recorded yet.'}`;

  return [
    `Persistent goal: ${state.objective}`,
    '',
    context,
    'Make concrete progress toward the goal in this turn. Follow project conventions and existing tool approval/safety boundaries. Run relevant checks and inspect their results.',
    `Before ending this turn, call the goal_report tool exactly once with a concise progress summary and status: use "continue" if work remains, "completed" only after checking the acceptance criteria and relevant verification, or "blocked" if user input or an unavailable capability prevents safe progress. Do not guess when blocked; ask one focused clarifying question in your visible response. Do not mark completed based only on a plan or an unverified claim.`,
    'If work remains, describe what is done, what remains, and the latest checks in the report so the next iteration can continue from evidence.',
  ].join('\n');
}
