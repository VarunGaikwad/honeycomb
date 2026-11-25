# Tool Call System — Implementation Plan

## 1. Overview

Define a unified tool-calling system for the AI Coding Agent.

The system should allow the AI to interact with:

- File System
- Shell & Process Management
- Git
- Code Execution
- Agent Intelligence
- Context & Memory Management

## 2. Tool Architecture

Implement the following architecture:

AI Agent
↓
Tool Registry
↓
Tool Dispatcher
↓
Permission Manager
↓
Tool Executor
↓
Tool Result
↓
AI Agent

## 3. Tool Categories

### A. File System Tools

| Tool   | Description                     |
| ------ | ------------------------------- |
| read   | Read file contents              |
| write  | Create or overwrite files       |
| edit   | Modify existing file contents   |
| ls     | List directory contents         |
| find   | Search files by name or pattern |
| grep   | Search text inside files        |
| mkdir  | Create directories              |
| delete | Delete files or directories     |
| move   | Move or rename files            |
| copy   | Copy files or directories       |

### B. Execution Tools

| Tool       | Description                                 |
| ---------- | ------------------------------------------- |
| bash       | Execute shell commands                      |
| process    | Manage running processes                    |
| kill       | Terminate processes                         |
| background | Execute long-running commands in background |
| terminal   | Manage interactive terminal sessions        |
| run_code   | Execute code in supported languages         |

### C. Git Tools

| Tool         | Description               |
| ------------ | ------------------------- |
| git_status   | Inspect repository status |
| git_diff     | Inspect file changes      |
| git_log      | Read commit history       |
| git_commit   | Create commits            |
| git_branch   | Manage branches           |
| git_checkout | Switch branches           |
| git_add      | Stage file changes        |

### D. Agent Control Tools

| Tool        | Description                   |
| ----------- | ----------------------------- |
| todo        | Manage task lists             |
| ask_user    | Ask user for clarification    |
| plan        | Create implementation plans   |
| subagent    | Spawn specialized agents      |
| memory      | Save and retrieve context     |
| checkpoint  | Save recovery checkpoints     |
| undo        | Revert agent operations       |
| apply_patch | Apply structured code patches |

## 4. Common Tool Interface

Every tool must implement a consistent interface.

```typescript
interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;

  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

interface ToolContext {
  sessionId: string;
  workingDirectory: string;
  signal?: AbortSignal;
}

interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}
```

## 5. Tool Registry

Responsibilities:

- Register tools.
- Unregister tools.
- Retrieve tools by name.
- List available tools.
- Validate tool names.
- Generate model-compatible tool definitions.
- Prevent duplicate registrations.

## 6. Tool Dispatcher

Responsibilities:

- Receive tool calls from the AI.
- Identify the requested tool.
- Validate arguments.
- Route execution to the correct tool.
- Handle execution errors.
- Return structured results.
- Support sequential tool calls.
- Support cancellation.

## 7. Permission & Safety System

Implement permission checks before executing sensitive operations.

Requirements:

- Restrict filesystem access to authorized project directories.
- Prevent path traversal.
- Protect important files.
- Require approval for destructive operations.
- Restrict dangerous shell commands.
- Support execution timeouts.
- Support process cancellation.
- Keep an audit log of tool operations.

## 8. Tool Execution Lifecycle

1. AI generates a tool call.
2. Dispatcher receives the request.
3. Registry resolves the tool.
4. Arguments are validated.
5. Permission manager checks authorization.
6. Tool executor executes the operation.
7. Result is normalized.
8. Result is returned to the AI.
9. AI continues reasoning.

## 9. Error Handling

Standardize error categories:

- TOOL_NOT_FOUND
- INVALID_ARGUMENTS
- PERMISSION_DENIED
- FILE_NOT_FOUND
- PATH_NOT_ALLOWED
- EXECUTION_FAILED
- EXECUTION_TIMEOUT
- PROCESS_NOT_FOUND
- OPERATION_CANCELLED
- INTERNAL_ERROR

Errors should include useful messages and recovery suggestions without exposing sensitive system information.

## 10. Process Management

Create a shared Process Manager for:

- Foreground execution.
- Background execution.
- Interactive terminal sessions.
- Process polling.
- Output streaming.
- Graceful termination.
- Force termination.
- Process cleanup.

## 11. Operation History & Recovery

Implement:

- Tool execution history.
- Operation IDs.
- File modification tracking.
- Undo support.
- Checkpoint creation.
- Recovery metadata.
- Execution timestamps.

Undo must only revert changes owned by the agent and must not overwrite unrelated user modifications.

## 12. Implementation Phases

### Phase 1 — Core Infrastructure

- Tool interface
- Tool Registry
- Tool Dispatcher
- Argument validation
- Tool Result handling

### Phase 2 — File System

- read
- write
- edit
- ls
- find
- grep
- mkdir
- delete
- move
- copy

### Phase 3 — Execution

- bash
- process
- kill
- background
- terminal
- run_code

### Phase 4 — Git Integration

- git_status
- git_diff
- git_log
- git_commit
- git_branch
- git_checkout
- git_add

### Phase 5 — Agent Intelligence

- todo
- ask_user
- plan
- apply_patch
- undo

### Phase 6 — Advanced Features

- memory
- checkpoint
- subagent

## 13. Testing Requirements

Every tool must have:

- Input validation tests.
- Successful execution tests.
- Failure handling tests.
- Permission tests.
- Edge-case tests.

System-level tests:

- Multiple sequential tool calls.
- Tool execution cancellation.
- Invalid tool calls.
- Concurrent process management.
- Recovery after failed execution.
- Tool result delivery to AI.

## 14. Final Acceptance Criteria

The implementation is complete when:

- All tools are registered correctly.
- AI can discover available tools.
- AI can invoke tools using structured arguments.
- Tool results return to the AI correctly.
- Errors are handled consistently.
- Permissions are enforced.
- Long-running processes are manageable.
- File changes can be tracked and recovered.
- The complete system passes automated tests.

## 15. Future Extensions

Keep the architecture extensible for:

- Language Server Protocol (LSP)
- Debugger
- Browser automation
- Documentation search
- MCP integrations
- Database tools
- Remote execution
