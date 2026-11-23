import { createAdvancedTools } from './advanced.ts';
import { createAgentTools } from './agent.ts';
import { BI_CONFIG, type BiConfig } from '../config/index.ts';
import type { AskUserFn } from '../types/index.ts';
import { ToolDispatcher } from './dispatcher.ts';
import { createExecutionTools } from './execution.ts';
import { createFileSystemTools } from './filesystem.ts';
import { createGitTools } from './git.ts';
import { createUndoJournal } from './undo-journal.ts';
import { ToolRegistry } from './registry.ts';

/** Build a registry containing the configured tool groups. */
export function createToolSystem(options: { askUser?: AskUserFn; config?: BiConfig } = {}) {
  const registry = new ToolRegistry();
  const config = options.config ?? BI_CONFIG;
  if (!Number.isInteger(config.execution.timeoutMs) || config.execution.timeoutMs < 1) {
    throw new Error('execution.timeoutMs must be a positive integer');
  }
  const execution = createExecutionTools(undefined, {
    timeoutMs: config.execution.timeoutMs,
    maxOutputChars: config.output.maxChars,
  });
  const journal = config.toolGroups.agent ? createUndoJournal() : undefined;
  const tools = [
    ...(config.toolGroups.filesystem ? createFileSystemTools({ ...config.filesystem, journal }) : []),
    ...(config.toolGroups.execution ? execution.tools : []),
    ...(config.toolGroups.git ? createGitTools(config.git) : []),
    ...(config.toolGroups.agent ? createAgentTools({ ...options, journal }) : []),
    ...(config.toolGroups.advanced ? createAdvancedTools() : []),
  ];
  for (const tool of tools) registry.register(tool);
  return {
    registry,
    dispatcher: new ToolDispatcher(registry, config.output.maxChars),
    processManager: execution.processManager,
  };
}

export * from '../types/index.ts';
export { ToolRegistry } from './registry.ts';
export { ToolDispatcher } from './dispatcher.ts';
export { createFileSystemTools } from './filesystem.ts';
export { createExecutionTools, ProcessManager } from './execution.ts';
export { createGitTools } from './git.ts';
export { createAgentTools } from './agent.ts';
export { createAdvancedTools } from './advanced.ts';
export { BI_CONFIG } from '../config/index.ts';
export type { BiConfig } from '../config/index.ts';
