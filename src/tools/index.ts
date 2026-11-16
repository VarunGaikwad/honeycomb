import { createAdvancedTools } from './advanced.ts';
import { createAgentTools } from './agent.ts';
import type { AskUserFn } from '../types/index.ts';
import { ToolDispatcher } from './dispatcher.ts';
import { createExecutionTools } from './execution.ts';
import { createFileSystemTools } from './filesystem.ts';
import { createGitTools } from './git.ts';
import { ToolRegistry } from './registry.ts';

/** Build a registry containing the implemented tools from all phases. */
export function createToolSystem(options: { askUser?: AskUserFn } = {}) {
  const registry = new ToolRegistry();
  const execution = createExecutionTools();
  const tools = [
    ...createFileSystemTools(),
    ...execution.tools,
    ...createGitTools(),
    ...createAgentTools(options),
    ...createAdvancedTools(),
  ];
  for (const tool of tools) registry.register(tool);
  return { registry, dispatcher: new ToolDispatcher(registry), processManager: execution.processManager };
}

export * from '../types/index.ts';
export { ToolRegistry } from './registry.ts';
export { ToolDispatcher } from './dispatcher.ts';
export { createFileSystemTools } from './filesystem.ts';
export { createExecutionTools, ProcessManager } from './execution.ts';
export { createGitTools } from './git.ts';
export { createAgentTools } from './agent.ts';
export { createAdvancedTools } from './advanced.ts';
