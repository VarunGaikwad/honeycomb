import type { Args } from './common.ts';
import type { ToolContext, ToolResult } from './tools.ts';

export interface Todo {
  id: string;
  text: string;
  done: boolean;
}

export interface UndoEntry {
  id: string;
  file: string;
  before: Buffer | null;
  afterHash: string;
}

export interface AgentToolDefinition {
  name: string;
  description: string;
  promptGuideline?: string;
  shape: Record<string, string>;
  execute: (args: Args, context: ToolContext) => Promise<ToolResult>;
  arrayItems?: Record<string, unknown>;
  parameters?: Record<string, unknown>;
}

export interface AskOption {
  label: string;
  description: string;
  recommended?: boolean;
}

export interface AskQuestion {
  id: string;
  header: string;
  question: string;
  multiSelect: boolean;
  options: AskOption[];
}

export interface AskAnswer {
  id: string;
  selected: string[];
  customText: string | null;
}

export type AskResult = { status: 'answered'; answers: AskAnswer[] } | { status: 'declined' };
export type AskUserFn = (questions: AskQuestion[]) => Promise<AskResult>;
