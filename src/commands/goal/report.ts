import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { readGoalState, saveGoalState } from './state.ts';

const parameters = Type.Object({
  status: Type.Union([
    Type.Literal('continue'),
    Type.Literal('completed'),
    Type.Literal('blocked'),
  ]),
  summary: Type.String({ minLength: 1, maxLength: 4_000 }),
  verification: Type.Optional(Type.Object({
    status: Type.Union([Type.Literal('passed'), Type.Literal('failed'), Type.Literal('not_run')]),
    summary: Type.String({ minLength: 1, maxLength: 1000 }),
  })),
});

export function registerGoalReportTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'goal_report',
    label: 'Report goal progress',
    description: 'Record verified progress on the active /goal and tell bi whether to continue, stop as completed, or report a blocker.',
    promptSnippet: 'Record progress and completion/blocker status for the active /goal',
    promptGuidelines: ['Call only while a persistent /goal is active. Include verification status and the checks actually run, or report not_run.'],
    parameters,
    execute: async (_toolCallId, args, _signal, _onUpdate, ctx) => {
      const goal = readGoalState(ctx.sessionManager.getBranch());
      if (!goal || goal.status !== 'active') {
        return {
          content: [{ type: 'text', text: 'There is no active goal to report progress for.' }],
          details: {},
          isError: true,
        };
      }
      if (goal.reportCount !== 0) {
        saveGoalState(pi, {
          ...goal,
          status: 'blocked',
          progress: 'More than one goal_report was submitted for this iteration.',
          reportCount: goal.reportCount + 1,
          updatedAt: Date.now(),
        });
        return {
          content: [{ type: 'text', text: 'A progress report was already recorded for this iteration; the goal is now blocked.' }],
          details: {},
          isError: true,
        };
      }
      const summary = args.summary.trim();
      if (!summary) {
        return {
          content: [{ type: 'text', text: 'The progress summary must not be empty.' }],
          details: {},
          isError: true,
        };
      }

      const status = args.status === 'continue' ? 'active' : args.status;
      saveGoalState(pi, { ...goal, status, progress: summary, verification: args.verification, reportCount: goal.reportCount + 1, updatedAt: Date.now() });
      return {
        content: [{ type: 'text', text: `Goal progress saved (${status}).` }],
        details: {},
      };
    },
  });
}
