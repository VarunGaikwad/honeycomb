import { BI_CONFIG } from '../config/index.ts';
import { loadProjectConfig } from '../config/project.ts';
import { CONFIG_LIMITS, OUTPUT_TRUNCATION_MARKER } from '../config/limits.ts';
import type { DispatchResult, ToolCall, ToolContext } from '../types/index.ts';
import { ToolRegistry } from './registry.ts';

export class ToolDispatcher {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly maxOutputChars = BI_CONFIG.output.maxChars,
  ) {
    if (!Number.isInteger(maxOutputChars) || maxOutputChars < CONFIG_LIMITS.minOutputChars ||
      maxOutputChars > CONFIG_LIMITS.maxOutputChars) {
      throw new Error(`output.maxChars must be an integer from ${CONFIG_LIMITS.minOutputChars} to ${CONFIG_LIMITS.maxOutputChars}`);
    }
  }

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
      const projectConfig = await loadProjectConfig(context.workingDirectory);
      if (context.signal?.aborted) {
        return { success: false, error: 'Tool execution was cancelled', errorCode: 'OPERATION_CANCELLED' };
      }
      const toolContext = { ...context, projectConfig };
      const result = normalizeResult(await tool.execute(call.arguments, toolContext));
      return limitOutput(result, projectConfig.output?.maxChars ?? this.maxOutputChars);
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

function limitOutput(result: DispatchResult, maxChars: number): DispatchResult {
  if (typeof result.output !== 'string' || result.output.length <= maxChars) return result;
  const contentLimit = maxChars - OUTPUT_TRUNCATION_MARKER.length;
  let content = result.output.slice(0, contentLimit);
  if (content.length > 0 && /[\uD800-\uDBFF]/u.test(content[content.length - 1])) {
    content = content.slice(0, -1);
  }
  return { ...result, output: content + OUTPUT_TRUNCATION_MARKER };
}
