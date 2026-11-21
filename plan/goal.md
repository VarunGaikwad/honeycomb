# **Plan: Build Codex-style&#x20;**`/goal`**&#x20;for Pi**

I'd build this as a standalone Pi extension called **Pi Goal Engine**.

The objective is to make Pi behave like a persistent autonomous coding agent: give it a goal once, let it work across multiple agent turns, track progress, recover from failures, and stop only when completion criteria are verified.

My recommendation: don't build `/goal` as just a prompt template. Build a small orchestration layer with persistent state.

## **1. Expected user experience**

```
/goal Build a production-ready authentication system
```

Pi should then:

- Analyze the project.
- Create an execution plan.
- Work through tasks independently.
- Track completed and remaining work.
- Run tests and inspect failures.
- Continue working when the goal is incomplete.
- Stop when verified, blocked, paused, or out of budget.

Example:

```
╭─ PI GOAL ─────────────────────────────────────╮
│ Goal: Build authentication system            │
│                                               │
│ Progress: 3/7 tasks                           │
│                                               │
│ ✓ Analyze existing project                    │
│ ✓ Create user model                           │
│ ✓ Implement registration                      │
│ ◉ Implement login                             │
│ ○ Add JWT middleware                          │
│ ○ Write automated tests                       │
│ ○ Verify complete system                      │
│                                               │
│ Status: RUNNING                               │
╰───────────────────────────────────────────────╯
```

## **2. Architecture**

I'd split the extension into six modules.

**/goal Command Interface**

Start · Status · Pause · Resume · Clear

**Goal Manager**

Lifecycle · Validation · Budget · State transitions

**Planner**

Milestones and tasks

**Executor**

Agent continuation

**Verifier**

Tests and evidence

**Persistence**

Session state and recovery

### **Suggested project structure**

```
pi-goal/
├── index.ts
├── commands/
│   └── goal-command.ts
├── core/
│   ├── goal-manager.ts
│   ├── goal-runner.ts
│   ├── continuation.ts
│   └── budget-manager.ts
├── planner/
│   ├── planner.ts
│   └── task-manager.ts
├── verifier/
│   └── verifier.ts
├── storage/
│   └── goal-storage.ts
├── ui/
│   └── goal-widget.ts
└── types/
    └── goal.ts
```

## **3. Goal state design**

This is the most important part.

Every goal should have persistent state.

```
interface GoalState {
  id: string;
  objective: string;

  status:
    | "active"
    | "paused"
    | "completed"
    | "blocked"
    | "budget_exceeded";

  tasks: GoalTask[];

  iteration: number;
  maxIterations: number;

  createdAt: number;
  updatedAt: number;

  verification: {
    required: string[];
    passed: string[];
    failed: string[];
  };
}

interface GoalTask {
  id: string;
  title: string;
  status: "pending" | "running" | "completed" | "failed";
}
```

**Storage recommendation:** Use Pi's session entries as the source of truth, with a custom extension entry such as `goal-state`. This allows goal state to travel with the conversation and supports session recovery.

Avoid storing the only copy in an in-memory variable or a temporary JSON file.

## **4. The autonomous execution loop**

This is the heart of the feature.

Use Pi's lifecycle events:

- `agent_start`: detect a new execution turn.
- `agent_end`: inspect what happened and decide whether to continue.
- `session_start`: restore the active goal.
- `session_switch`, `session_fork`, `session_tree`: synchronize state with the current session branch.

Pi provides these extension hooks and supports sending follow-up messages programmatically.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://github.com&sz=32)

GitHub+2

The execution flow:

\#chatgpt-mermaid-\_r_hp\_{font-family:Geist,Inter,-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:16px;fill:rgb(237, 237, 237);}@keyframes edge-animation-frame{from{stroke-dashoffset:0;}}@keyframes dash{to{stroke-dashoffset:0;}}#chatgpt-mermaid-\_r_hp\_ .edge-animation-slow{stroke-dasharray:9,5!important;stroke-dashoffset:900;animation:dash 50s linear infinite;stroke-linecap:round;}#chatgpt-mermaid-\_r_hp\_ .edge-animation-fast{stroke-dasharray:9,5!important;stroke-dashoffset:900;animation:dash 20s linear infinite;stroke-linecap:round;}#chatgpt-mermaid-\_r_hp\_ .error-icon{fill:rgba(237, 237, 237, 0.027);}#chatgpt-mermaid-\_r_hp\_ .error-text{fill:rgb(237, 237, 237);stroke:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_hp\_ .edge-thickness-normal{stroke-width:1px;}#chatgpt-mermaid-\_r_hp\_ .edge-thickness-thick{stroke-width:3.5px;}#chatgpt-mermaid-\_r_hp\_ .edge-pattern-solid{stroke-dasharray:0;}#chatgpt-mermaid-\_r_hp\_ .edge-thickness-invisible{stroke-width:0;fill:none;}#chatgpt-mermaid-\_r_hp\_ .edge-pattern-dashed{stroke-dasharray:3;}#chatgpt-mermaid-\_r_hp\_ .edge-pattern-dotted{stroke-dasharray:2;}#chatgpt-mermaid-\_r_hp\_ .marker{fill:rgba(237, 237, 237, 0.47);stroke:rgba(237, 237, 237, 0.47);}#chatgpt-mermaid-\_r_hp\_ .marker.cross{stroke:rgba(237, 237, 237, 0.47);}#chatgpt-mermaid-\_r_hp\_ svg{font-family:Geist,Inter,-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:16px;}#chatgpt-mermaid-\_r_hp\_ p{margin:0;}#chatgpt-mermaid-\_r_hp\_ .label{font-family:Geist,Inter,-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";color:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_hp\_ .cluster-label text{fill:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_hp\_ .cluster-label span{color:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_hp\_ .cluster-label span p{background-color:transparent;}#chatgpt-mermaid-\_r_hp\_ .label text,#chatgpt-mermaid-\_r_hp\_ span{fill:rgb(237, 237, 237);color:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_hp\_ .node rect,#chatgpt-mermaid-\_r_hp\_ .node circle,#chatgpt-mermaid-\_r_hp\_ .node ellipse,#chatgpt-mermaid-\_r_hp\_ .node polygon,#chatgpt-mermaid-\_r_hp\_ .node path{fill:rgb(0, 25, 59);stroke:rgb(91, 162, 254);stroke-width:1px;}#chatgpt-mermaid-\_r_hp\_ .rough-node .label text,#chatgpt-mermaid-\_r_hp\_ .node .label text,#chatgpt-mermaid-\_r_hp\_ .image-shape .label,#chatgpt-mermaid-\_r_hp\_ .icon-shape .label{text-anchor:middle;}#chatgpt-mermaid-\_r_hp\_ .node .katex path{fill:#000;stroke:#000;stroke-width:1px;}#chatgpt-mermaid-\_r_hp\_ .rough-node .label,#chatgpt-mermaid-\_r_hp\_ .node .label,#chatgpt-mermaid-\_r_hp\_ .image-shape .label,#chatgpt-mermaid-\_r_hp\_ .icon-shape .label{text-align:center;}#chatgpt-mermaid-\_r_hp\_ .node.clickable{cursor:pointer;}#chatgpt-mermaid-\_r_hp\_ .root .anchor path{fill:rgba(237, 237, 237, 0.47)!important;stroke-width:0;stroke:rgba(237, 237, 237, 0.47);}#chatgpt-mermaid-\_r_hp\_ .arrowheadPath{fill:rgba(237, 237, 237, 0.47);}#chatgpt-mermaid-\_r_hp\_ .edgePath .path{stroke:rgba(237, 237, 237, 0.47);stroke-width:1px;}#chatgpt-mermaid-\_r_hp\_ .flowchart-link{stroke:rgba(237, 237, 237, 0.47);fill:none;}#chatgpt-mermaid-\_r_hp\_ .edgeLabel{background-color:rgb(0, 0, 0);text-align:center;}#chatgpt-mermaid-\_r_hp\_ .edgeLabel p{background-color:rgb(0, 0, 0);}#chatgpt-mermaid-\_r_hp\_ .edgeLabel rect{opacity:0.5;background-color:rgb(0, 0, 0);fill:rgb(0, 0, 0);}#chatgpt-mermaid-\_r_hp\_ .labelBkg{background-color:rgba(0, 0, 0, 0.5);}#chatgpt-mermaid-\_r_hp\_ .cluster rect{fill:rgba(237, 237, 237, 0.027);stroke:rgba(237, 237, 237, 0.075);stroke-width:1px;}#chatgpt-mermaid-\_r_hp\_ .cluster text{fill:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_hp\_ .cluster span{color:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_hp\_ div.mermaidTooltip{position:absolute;text-align:center;max-width:200px;padding:2px;font-family:Geist,Inter,-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:12px;background:rgba(237, 237, 237, 0.027);border:1px solid rgba(237, 237, 237, 0.075);border-radius:2px;pointer-events:none;z-index:100;}#chatgpt-mermaid-\_r_hp\_ .flowchartTitleText{text-anchor:middle;font-size:18px;fill:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_hp\_ rect.text{fill:none;stroke-width:0;}#chatgpt-mermaid-\_r_hp\_ .icon-shape,#chatgpt-mermaid-\_r_hp\_ .image-shape{background-color:rgb(0, 0, 0);text-align:center;}#chatgpt-mermaid-\_r_hp\_ .icon-shape p,#chatgpt-mermaid-\_r_hp\_ .image-shape p{background-color:rgb(0, 0, 0);padding:2px;}#chatgpt-mermaid-\_r_hp\_ .icon-shape .label rect,#chatgpt-mermaid-\_r_hp\_ .image-shape .label rect{opacity:0.5;background-color:rgb(0, 0, 0);fill:rgb(0, 0, 0);}#chatgpt-mermaid-\_r_hp\_ .label-icon{display:inline-block;height:1em;overflow:visible;vertical-align:-0.125em;}#chatgpt-mermaid-\_r_hp\_ .node .label-icon path{fill:currentColor;stroke:revert;stroke-width:revert;}#chatgpt-mermaid-\_r_hp\_ .node .neo-node{stroke:rgb(91, 162, 254);}#chatgpt-mermaid-\_r_hp\_ [data-look="neo"].node rect,#chatgpt-mermaid-\_r_hp\_ [data-look="neo"].cluster rect,#chatgpt-mermaid-\_r_hp\_ [data-look="neo"].node polygon{stroke:url(#chatgpt-mermaid-\_r_hp\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_hp\_ [data-look="neo"].swimlane.cluster rect{filter:none;}#chatgpt-mermaid-\_r_hp\_ [data-look="neo"].node path{stroke:url(#chatgpt-mermaid-\_r_hp\_-gradient);stroke-width:1px;}#chatgpt-mermaid-\_r_hp\_ [data-look="neo"].node .outer-path{filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_hp\_ [data-look="neo"].node .neo-line path{stroke:rgb(91, 162, 254);filter:none;}#chatgpt-mermaid-\_r_hp\_ [data-look="neo"].node circle{stroke:url(#chatgpt-mermaid-\_r_hp\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_hp\_ [data-look="neo"].node circle .state-start{fill:#000000;}#chatgpt-mermaid-\_r_hp\_ [data-look="neo"].icon-shape .icon{fill:url(#chatgpt-mermaid-\_r_hp\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_hp\_ [data-look="neo"].icon-shape .icon-neo path{stroke:url(#chatgpt-mermaid-\_r_hp\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_hp\_ .node text{font-size:14px;font-weight:600;letter-spacing:normal;fill:rgb(91, 162, 254);}#chatgpt-mermaid-\_r_hp\_ .edgeLabels text{font-size:13px;font-weight:600;letter-spacing:-0.08px;fill:rgb(91, 162, 254);}#chatgpt-mermaid-\_r_hp\_ .node tspan[font-weight="normal"],#chatgpt-mermaid-\_r_hp\_ .edgeLabels tspan[font-weight="normal"]{font-weight:600;}#chatgpt-mermaid-\_r_hp\_ .edgeLabel .label rect{opacity:1;rx:13px;ry:13px;fill:rgb(0, 0, 0);stroke:rgb(91, 162, 254);stroke-width:1px;}#chatgpt-mermaid-\_r_hp\_ .node rect,#chatgpt-mermaid-\_r_hp\_ .node circle,#chatgpt-mermaid-\_r_hp\_ .node ellipse,#chatgpt-mermaid-\_r_hp\_ .node polygon,#chatgpt-mermaid-\_r_hp\_ .node path{fill:rgb(0, 25, 59);stroke:rgba(255, 255, 255, 0.1);stroke-width:1px;}#chatgpt-mermaid-\_r_hp\_ .node rect{rx:16px;ry:16px;}#chatgpt-mermaid-\_r_hp\_ .mermaid-decision .label-container{fill:rgb(0, 0, 0);stroke:rgb(91, 162, 254);stroke-dasharray:2,2;}#chatgpt-mermaid-\_r_hp\_ .edgePaths .flowchart-link{stroke:rgba(237, 237, 237, 0.47);stroke-width:1px;stroke-linecap:round;stroke-linejoin:round;}#chatgpt-mermaid-\_r_hp\_ .marker{fill:rgba(237, 237, 237, 0.47);stroke:rgba(237, 237, 237, 0.47);}#chatgpt-mermaid-\_r_hp\_ :root{--mermaid-font-family:Geist,Inter,-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";}Start /goalCreate GoalGenerate PlanExecute Agent TurnInspect ResultsGoal achieved?Mark CompleteCan continue?Update ProgressQueue ContinuationAsk User / Mark BlockedStop and ReportWait for ResumeYes, verifiedNoYesBlockedBudget exhaustedPaused

### **Continuation logic**

Your `agent_end` handler should:

1. Check whether a goal is active.
2. Check whether the user has paused or cleared it.
3. Inspect the latest agent output and tool results.
4. Update iteration and budget counters.
5. Decide whether more work is needed.
6. Queue a continuation prompt if appropriate.

Example pseudocode:

```
pi.on("agent_end", async (event, ctx) => {
  const goal = goalManager.getActive();

  if (!goal || goal.status !== "active") return;

  if (goal.iteration >= goal.maxIterations) {
    goalManager.setStatus("budget_exceeded");
    return;
  }

  const result = await verifier.evaluate(goal, event);

  if (result.completed) {
    goalManager.setStatus("completed");
    return;
  }

  if (result.needsUserInput) {
    goalManager.setStatus("blocked");
    return;
  }

  goalManager.incrementIteration();

  pi.sendUserMessage(
    continuation.buildPrompt(goal, result)
  );
});
```

This is architectural pseudocode, not drop-in Pi code. Add a reentrancy guard and ensure continuation only happens when the session is idle and no user message is pending.

### **5. Design the continuation prompt**

Don't simply send the original goal again.

Create a dedicated prompt template:

```
You are working toward the following persistent goal:

{{objective}}

CURRENT PROGRESS:
{{progress}}

PREVIOUS ATTEMPT:
{{previous_result}}

REMAINING TASKS:
{{remaining_tasks}}

INSTRUCTIONS:

1. Inspect the current project state.
2. Identify the highest-priority unfinished task.
3. Make concrete progress.
4. Run relevant verification commands.
5. Record evidence and update progress.
6. Do not claim completion without verification.
7. If blocked, explain exactly what is missing.

Continue toward the original objective.
```

This follows the same core principle in Codex's published continuation design: preserve the full objective, use current evidence, and distinguish completion from budget exhaustion or blockers.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://developers.openai.com&sz=32)

OpenAI Developers+1

## **6. Command interface**

I'd implement these commands:

| Command             | Behavior               |
| ------------------- | ---------------------- |
| `/goal <objective>` | Create and start goal  |
| `/goal`             | Show current goal      |
| `/goal status`      | Show detailed progress |
| `/goal pause`       | Pause continuation     |
| `/goal resume`      | Resume execution       |
| `/goal clear`       | Remove active goal     |
| `/goal edit <text>` | Update objective       |
| `/goal budget <n>`  | Set iteration limit    |

Also add a persistent TUI widget showing goal progress.

## **7. Development roadmap**

I'd implement this in five phases rather than building everything at once.

1. **Phase 1 — Basic Goal Manager**

   Priority: Critical
   - Register `/goal`.
   - Create and store goals.
   - Implement pause, resume, clear and status.
   - Restore state after restarting Pi.

   Deliverable: Persistent goal management.

2. **Phase 2 — Autonomous Continuation**

   Priority: Critical
   - Implement `agent_end` handling.
   - Build continuation prompts.
   - Automatically schedule subsequent turns.
   - Prevent infinite continuation loops.

   Deliverable: Pi keeps working without repeated user prompts.

3. **Phase 3 — Planner & Progress**
   - Generate milestones and tasks.
   - Track task status.
   - Update progress after each iteration.
   - Display a TUI progress widget.

   Deliverable: Visible execution progress.

4. **Phase 4 — Verification Engine**
   - Run relevant tests.
   - Inspect command outputs.
   - Verify each completion criterion.
   - Detect blockers and report evidence.

   Deliverable: Evidence-based completion.

5. **Phase 5 — Production Hardening**
   - Token and iteration budgets.
   - Interruption handling.
   - Session branching support.
   - Crash recovery.
   - Unit and integration tests.

   Deliverable: Reliable Pi Goal Engine.

## **8. Important engineering decisions**

These are the things I'd be particularly careful about:

| Problem               | Recommended solution                    |
| --------------------- | --------------------------------------- |
| Infinite loops        | Iteration and token budgets             |
| False completion      | Independent verification                |
| Restart recovery      | Session persistence                     |
| User interrupts       | Pause continuation                      |
| Context compaction    | Preserve goal summary                   |
| Session branching     | Restore state from active branch        |
| Repeated continuation | Reentrancy guard                        |
| Failed commands       | Record evidence and retry intelligently |

One important detail: don't treat `agent_end` as proof that a goal is finished. It only tells you that an agent turn ended. Your verifier must make that decision.

## **9. MVP acceptance criteria**

Before calling version 1 complete, verify these:

- `/goal` creates a goal.
- Goal survives Pi restart.
- Pi automatically continues after an unfinished turn.
- User can interrupt execution.
- Pause/resume works.
- Progress survives context compaction.
- Goal completes only after verification.
- Budget exhaustion stops execution.
- No duplicate or infinite continuation turns.

## **My recommended implementation strategy**

Start with only three components:

1. `goal-manager.ts`
2. `goal-runner.ts`
3. `index.ts`

Get persistent state and autonomous continuation working first. Then add planning, verification and UI.

**Reference material:**

- [OpenAI — Using Goals in Codex](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex?utm_source=chatgpt.com)
- [Codex — Continuation prompt implementation](https://github.com/openai/codex/blob/main/codex-rs/ext/goal/templates/goals/continuation.md?utm_source=chatgpt.com)
- [Pi — Extension API documentation](https://github.com/fivewillow/badlogic-pi-mono/blob/main/packages/coding-agent/docs/extensions.md?utm_source=chatgpt.com)

**My suggestion:** Build this as a faithful implementation of the Goal concept, not a copy of Codex's internal implementation. The most important features are durable state, safe continuation, and evidence-based completion.

That will give your Pi CLI a genuinely useful autonomous coding mode.
