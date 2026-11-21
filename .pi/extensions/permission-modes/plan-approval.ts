export const PLAN_APPROVAL_OPTIONS = [
  "Approve → switch to acceptEdits and start",
  "Approve → switch to default",
  "Keep planning",
  "Discard",
] as const;

export type PlanDecision = "acceptEdits" | "default" | "keep" | "discard";

export function planDecision(selection: string | undefined): PlanDecision {
  if (selection === PLAN_APPROVAL_OPTIONS[0]) return "acceptEdits";
  if (selection === PLAN_APPROVAL_OPTIONS[1]) return "default";
  if (selection === PLAN_APPROVAL_OPTIONS[3]) return "discard";
  return "keep";
}
