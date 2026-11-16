import type { ChildProcess } from 'node:child_process';
import type { ToolContext } from './tools.ts';

export interface ManagedProcess {
  child: ChildProcess;
  output: string;
  exited?: { code: number | null; signal: NodeJS.Signals | null };
}

export interface ExecutionOptions {
  /** Upper bound for foreground commands. Defaults to 30 seconds. */
  timeoutMs?: number;
  /** Optional command policy. Deny by default only when this callback rejects. */
  allowCommand?: (command: string, context: ToolContext) => boolean | Promise<boolean>;
}
