import type { ProjectConfig } from '../config/project.ts';

export interface ToolContext {
  sessionId: string;
  workingDirectory: string;
  projectConfig?: ProjectConfig;
  signal?: AbortSignal;
  confirmDestructive?: (operation: string, target: string) => Promise<boolean>;
  confirmCommand?: (command: string) => Promise<boolean>;
  askUser?: (question: string) => Promise<string>;
  delegateAgent?: (task: string) => Promise<string>;
}

export interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface Tool<Args extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  promptSnippet?: string;
  promptGuidelines?: string[];
  validate?: (args: unknown) => args is Args;
  execute(args: Args, context: ToolContext): Promise<ToolResult>;
}

export type ToolErrorCode =
  | 'TOOL_NOT_FOUND'
  | 'INVALID_ARGUMENTS'
  | 'OPERATION_CANCELLED'
  | 'EXECUTION_FAILED'
  | 'INTERNAL_ERROR';

export interface ToolCall {
  name: string;
  arguments: unknown;
}

export interface DispatchResult extends ToolResult {
  errorCode?: ToolErrorCode;
}
