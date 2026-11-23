import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { registerGoalReportTool } from './report.ts';
import {
  buildGoalPrompt,
  DEFAULT_GOAL_ITERATIONS,
  GOAL_STATE_ENTRY,
  goalStatusText,
  MAX_GOAL_ITERATIONS,
  readGoalState,
  saveGoalState,
  saveGoalStateDraft,
  type GoalState,
} from './state.ts';

export function registerGoalCommand(pi: ExtensionAPI): void {
  registerGoalReportTool(pi);
  registerGoalLifecycle(pi);

  pi.registerCommand('goal', {
    description: 'Start or manage a persistent, bounded goal for this session',
    handler: async (args, ctx) => {
      const input = args.trim();
      const [command, ...rest] = input.split(/\s+/);
      const argument = rest.join(' ').trim();
      const goal = readGoalState(ctx.sessionManager.getBranch());

      switch (command) {
        case undefined:
        case 'status':
          ctx.ui.notify(goal ? goalStatusText(goal) : 'No goal is saved for this session. Start one with /goal <objective>.', 'info');
          return;
        case 'pause':
          if (!goal || goal.status !== 'active') {
            ctx.ui.notify('There is no active goal to pause.', 'warning');
            return;
          }
          saveGoalState(pi, { ...goal, status: 'paused', updatedAt: Date.now() });
          ctx.ui.notify('Goal paused. The current turn may finish; no further goal iterations will be scheduled.', 'info');
          return;
        case 'resume':
          if (!goal || goal.status === 'completed') {
            ctx.ui.notify('There is no resumable goal. Start one with /goal <objective>.', 'warning');
            return;
          }
          if (goal.status === 'active') {
            ctx.ui.notify('The goal is already active.', 'info');
            return;
          }
          if (!ctx.isIdle()) {
            ctx.ui.notify('Wait for the current run to finish before resuming the goal.', 'warning');
            return;
          }
          {
            const resumed: GoalState = {
              ...goal,
              status: 'active',
              iteration: goal.status === 'budget_exceeded' ? 0 : goal.iteration,
              reportCount: 0,
              updatedAt: Date.now(),
            };
            saveGoalState(pi, resumed);
            ctx.ui.notify('Resuming goal.', 'info');
            pi.sendUserMessage(buildGoalPrompt(resumed));
            return;
          }
        case 'clear':
          if (!goal) {
            ctx.ui.notify('There is no saved goal to clear.', 'info');
            return;
          }
          pi.appendEntry(GOAL_STATE_ENTRY, null);
          ctx.ui.notify('Saved goal cleared. The current turn, if any, is not cancelled.', 'info');
          return;
        case 'edit':
          if (!argument) {
            ctx.ui.notify('Usage: /goal edit <new objective>', 'warning');
            return;
          }
          if (!goal || goal.status === 'completed') {
            ctx.ui.notify('There is no editable goal. Start one with /goal <objective>.', 'warning');
            return;
          }
          if (!ctx.isIdle()) {
            ctx.ui.notify('Wait for the current run to finish before editing the goal.', 'warning');
            return;
          }
          {
            const edited = {
              ...goal,
              objective: argument,
              progress: 'Objective updated. Reassess the plan and acceptance criteria.',
              verification: undefined,
              iteration: 0,
              reportCount: 0,
              status: goal.status === 'paused' ? 'paused' as const : 'active' as const,
              updatedAt: Date.now(),
            };
            saveGoalState(pi, edited);
            ctx.ui.notify('Goal objective updated.', 'info');
            if (edited.status === 'active') pi.sendUserMessage(buildGoalPrompt(edited));
            return;
          }
        case 'budget': {
          const budget = Number(argument);
          if (!goal || !Number.isInteger(budget) || budget < 1 || budget > MAX_GOAL_ITERATIONS) {
            ctx.ui.notify(`Usage: /goal budget <1-${MAX_GOAL_ITERATIONS}> (requires a saved goal)`, 'warning');
            return;
          }
          const updated: GoalState = {
            ...goal,
            maxIterations: budget,
            status: (goal.status === 'active' || goal.status === 'paused') && goal.iteration >= budget
              ? 'budget_exceeded'
              : goal.status,
            updatedAt: Date.now(),
          };
          saveGoalState(pi, updated);
          ctx.ui.notify(`Goal iteration budget set to ${budget}.`, 'info');
          return;
        }
        default:
          if (!ctx.isIdle()) {
            ctx.ui.notify('Wait for the current run to finish before starting a goal.', 'warning');
            return;
          }
          if (goal?.status === 'active' || goal?.status === 'paused') {
            ctx.ui.notify('A goal is already in progress. Use /goal status, /goal pause, or /goal clear first.', 'warning');
            return;
          }
          await startGoal(pi, ctx, input);
      }
    },
  });
}

async function startGoal(pi: ExtensionAPI, ctx: ExtensionCommandContext, objective: string): Promise<void> {
  if (!objective) {
    ctx.ui.notify('Usage: /goal <objective>', 'warning');
    return;
  }
  const now = Date.now();
  const goal: GoalState = {
    version: 1,
    objective,
    status: 'active',
    progress: '',
    iteration: 0,
    reportCount: 0,
    maxIterations: DEFAULT_GOAL_ITERATIONS,
    createdAt: now,
    updatedAt: now,
  };
  saveGoalState(pi, goal);
  ctx.ui.notify(`Starting goal (up to ${goal.maxIterations} automatic iterations): ${objective}`, 'info');
  pi.sendUserMessage(buildGoalPrompt(goal, true));
}

function registerGoalLifecycle(pi: ExtensionAPI): void {
  pi.on('agent_before_settle', (event, ctx) => {
    const goal = readGoalState([...ctx.sessionManager.getBranch(), ...event.entries]);
    if (!goal || goal.status !== 'active') return;

    if (event.outcome === 'error') {
      const blocked: GoalState = {
        ...goal,
        status: 'blocked',
        progress: 'The agent turn ended with an error. Inspect the error before resuming.',
        updatedAt: Date.now(),
      };
      ctx.ui.notify('Goal stopped because the agent turn failed. Use /goal status, then /goal resume after resolving the issue.', 'warning');
      return { entries: [...event.entries, saveGoalStateDraft(blocked)] };
    }

    if (event.outcome === 'aborted') return;

    if (ctx.hasPendingMessages() || event.context.pendingMessages.length > 0) {
      if (goal.reportCount === 0) return;
      return {
        entries: [
          ...event.entries,
          saveGoalStateDraft({ ...goal, reportCount: 0, updatedAt: Date.now() }),
        ],
      };
    }

    if (goal.reportCount !== 1) {
      const unreported: GoalState = {
        ...goal,
        status: 'blocked',
        progress: 'The agent turn ended without exactly one goal_report for this iteration.',
        updatedAt: Date.now(),
      };
      ctx.ui.notify('Goal stopped because this turn did not produce exactly one progress report. Use /goal status, then /goal resume to continue.', 'warning');
      return { entries: [...event.entries, saveGoalStateDraft(unreported)] };
    }

    if (goal.iteration >= goal.maxIterations) {
      const exhausted: GoalState = {
        ...goal,
        status: 'budget_exceeded',
        updatedAt: Date.now(),
      };
      ctx.ui.notify(`Goal iteration budget (${goal.maxIterations}) reached. Use /goal resume for another bounded run.`, 'warning');
      return { entries: [...event.entries, saveGoalStateDraft(exhausted)] };
    }

    const next: GoalState = { ...goal, iteration: goal.iteration + 1, reportCount: 0, updatedAt: Date.now() };
    return {
      entries: [
        ...event.entries,
        saveGoalStateDraft(next),
        {
          type: 'custom_message',
          customType: 'bi.goal-continuation',
          content: buildGoalPrompt(next),
          display: false,
        },
      ],
      continue: true,
    };
  });

  // An Escape/abort skips agent_before_settle in Pi. Persist a pause here so the
  // goal never resumes automatically after an intentional interruption.
  pi.on('agent_settled', (event, ctx) => {
    if (!event.aborted) return;
    const goal = readGoalState(ctx.sessionManager.getBranch());
    if (!goal || goal.status !== 'active') return;
    saveGoalState(pi, { ...goal, status: 'paused', updatedAt: Date.now() });
    ctx.ui.notify('Goal paused after interruption. Use /goal resume to continue.', 'info');
  });

  // Recover active goals on restart/fork, but never auto-run on a new session or
  // extension reload. Reconcile a report saved just before a process restart.
  pi.on('session_start', (event, ctx) => {
    const saved = readGoalState(ctx.sessionManager.getBranch());
    if (!saved || saved.status !== 'active') return;
    let goal = saved;
    if (goal.reportCount > 0) {
      if (goal.iteration >= goal.maxIterations) {
        goal = { ...goal, status: 'budget_exceeded', reportCount: 0, updatedAt: Date.now() };
        saveGoalState(pi, goal);
        ctx.ui.notify(`Goal iteration budget (${goal.maxIterations}) reached before session recovery.`, 'warning');
        return;
      }
      goal = { ...goal, iteration: goal.iteration + 1, reportCount: 0, updatedAt: Date.now() };
      saveGoalState(pi, goal);
    }
    if (event.reason !== 'startup' && event.reason !== 'resume' && event.reason !== 'fork') return;
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
    ctx.ui.notify(`Resuming saved goal: ${goal.objective}`, 'info');
    pi.sendUserMessage(buildGoalPrompt(goal));
  });
}
