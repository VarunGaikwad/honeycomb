import type { DispatchResult, ToolCall, ToolContext } from '../types/index.ts';
import { ToolRegistry } from './registry.ts';

export class ToolDispatcher {
  constructor(private readonly registry: ToolRegistry) {}

  async dispatch(call: ToolCall, context: ToolContext): Promise<DispatchResult> {
    if (context.signal?.aborted) {
      return { success: false, error: 'Tool execution was cancelled', errorCode: 'OPERATION_CANCELLED' };
    }
    const tool = this.registry.get(call.name);
    if (!tool) return { success: false, error: `Unknown tool: ${call.name}`, errorCode: 'TOOL_NOT_FOUND' };
    if (!isArguments(call.arguments) || (tool.validate && !tool.validate(call.arguments))) {
      return { success: false, error: `Invalid arguments for tool: ${call.name}`, errorCode: 'INVALID_ARGUMENTS' };
    }

    try {
      const result = await tool.execute(call.arguments, context);
      return normalizeResult(result);
    } catch (error) {
      if (context.signal?.aborted) {
        return { success: false, error: 'Tool execution was cancelled', errorCode: 'OPERATION_CANCELLED' };
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Tool execution failed',
        errorCode: 'EXECUTION_FAILED',
      };
    }
  }

  async dispatchSequential(calls: ToolCall[], context: ToolContext): Promise<DispatchResult[]> {
    const results: DispatchResult[] = [];
    for (const call of calls) {
      if (context.signal?.aborted) {
        results.push({ success: false, error: 'Tool execution was cancelled', errorCode: 'OPERATION_CANCELLED' });
        break;
      }
      results.push(await this.dispatch(call, context));
    }
    return results;
  }
}

function isArguments(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeResult(value: unknown): DispatchResult {
  if (!value || typeof value !== 'object' || typeof (value as { success?: unknown }).success !== 'boolean') {
    return { success: false, error: 'Tool returned an invalid result', errorCode: 'INTERNAL_ERROR' };
  }
  return value as DispatchResult;
}
