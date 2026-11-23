import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { BI_CONFIG } from '../config/index.ts';
import { CONFIG_LIMITS, OUTPUT_TRUNCATION_MARKER } from '../config/limits.ts';
import type {
  ExecutionOptions,
  ManagedProcess,
  Tool,
  ToolContext,
  ToolResult,
} from '../types/index.ts';

/** Shared process lifecycle for foreground and background execution tools. */
export class ProcessManager {
  private readonly processes = new Map<string, ManagedProcess>();

  constructor(private readonly maxOutputChars = BI_CONFIG.output.maxChars) {
    validateOutputLimit(maxOutputChars);
  }

  start(command: string, context: ToolContext): { id: string; process: ManagedProcess } {
    const maxOutputChars = context.projectConfig?.output?.maxChars ?? this.maxOutputChars;
    validateOutputLimit(maxOutputChars);
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: context.workingDirectory,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const managed: ManagedProcess = { child, output: '' };
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    child.stdout?.on('data', (chunk: Buffer) => appendOutput(managed, stdoutDecoder.write(chunk), maxOutputChars));
    child.stderr?.on('data', (chunk: Buffer) => appendOutput(managed, stderrDecoder.write(chunk), maxOutputChars));
    child.stdout?.on('end', () => appendOutput(managed, stdoutDecoder.end(), maxOutputChars));
    child.stderr?.on('end', () => appendOutput(managed, stderrDecoder.end(), maxOutputChars));
    child.on('exit', (code, signal) => { managed.exited = { code, signal }; });
    const id = randomUUID();
    this.processes.set(id, managed);
    return { id, process: managed };
  }

  get(id: string): ManagedProcess | undefined {
    return this.processes.get(id);
  }

  remove(id: string): boolean {
    return this.processes.delete(id);
  }

  list(): Array<{ id: string; running: boolean; output: string }> {
    return [...this.processes].map(([id, p]) => ({ id, running: !p.exited, output: p.output }));
  }
}

function appendOutput(process: ManagedProcess, text: string, maxChars: number): void {
  if (process.outputTruncated) return;
  const remaining = maxChars - OUTPUT_TRUNCATION_MARKER.length - process.output.length;
  if (text.length <= remaining) {
    process.output += text;
    return;
  }
  let prefix = text.slice(0, Math.max(0, remaining));
  const lastCodeUnit = prefix.charCodeAt(prefix.length - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) prefix = prefix.slice(0, -1);
  process.output += prefix + OUTPUT_TRUNCATION_MARKER;
  process.outputTruncated = true;
}

function validateOutputLimit(maxChars: number): void {
  if (!Number.isInteger(maxChars) || maxChars < CONFIG_LIMITS.minOutputChars ||
    maxChars > CONFIG_LIMITS.maxOutputChars) {
    throw new Error(`output.maxChars must be an integer from ${CONFIG_LIMITS.minOutputChars} to ${CONFIG_LIMITS.maxOutputChars}`);
  }
}

export function createExecutionTools(
  manager: ProcessManager | undefined = undefined,
  options: ExecutionOptions = {},
): { tools: Tool<any>[]; processManager: ProcessManager } {
  const processManager = manager ?? new ProcessManager(options.maxOutputChars);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const authorize = async (command: string, context: ToolContext) =>
    options.allowCommand
      ? await options.allowCommand(command, context)
      : !!context.confirmCommand && await context.confirmCommand(command);
  const tools: Tool<any>[] = [
    execTool('bash', 'Run a shell command in the working directory', { command: 'string' }, async (a, c) => {
      const command = str(a, 'command');
      if (!await authorize(command, c)) return { success: false, error: 'Command denied by execution policy' };
      const { process } = processManager.start(command, c);
      const result = await waitForProcess(process, timeoutMs, c.signal);
      return result;
    }),
    execTool('background', 'Start a shell command in the background', { command: 'string' }, async (a, c) => {
      const command = str(a, 'command');
      if (!await authorize(command, c)) return { success: false, error: 'Command denied by execution policy' };
      const { id } = processManager.start(command, c);
      return { success: true, output: id, metadata: { processId: id } };
    }),
    execTool('process', 'Inspect a managed process and its captured output', { processId: 'string' }, async (a) => {
      const p = processManager.get(str(a, 'processId'));
      if (!p) return { success: false, error: 'Process not found' };
      return { success: true, output: p.output, metadata: {
        running: !p.exited,
        exitCode: p.exited?.code,
        signal: p.exited?.signal,
        outputTruncated: p.outputTruncated === true,
      } };
    }),
    execTool('kill', 'Terminate a managed process', { processId: 'string', force: 'boolean?' }, async (a) => {
      const id = str(a, 'processId');
      const p = processManager.get(id);
      if (!p) return { success: false, error: 'Process not found' };
      if (!p.exited) p.child.kill(a.force === true ? 'SIGKILL' : 'SIGTERM');
      return { success: true, output: `Termination requested for ${id}` };
    }),
    execTool('terminal', 'Start an interactive shell process or send input to one', { command: 'string?', processId: 'string?', input: 'string?' }, async (a, c) => {
      if (typeof a.input === 'string') {
        if (a.command !== undefined) return { success: false, error: 'Terminal command and input are mutually exclusive' };
        const p = processManager.get(str(a, 'processId'));
        if (!p?.child.stdin?.writable) return { success: false, error: 'Terminal process not found or stdin is closed' };
        if (!c.confirmCommand || !await c.confirmCommand(`Send terminal input to ${a.processId}:\n${a.input}`)) return { success: false, error: 'Terminal input was not approved' };
        if (c.signal?.aborted || !p.child.stdin.writable) return { success: false, error: 'Terminal input cancelled or stdin closed' };
        p.child.stdin.write(a.input);
        return { success: true, output: p.output, metadata: {
          running: !p.exited,
          outputTruncated: p.outputTruncated === true,
        } };
      }
      if (a.processId !== undefined || typeof a.command !== 'string') return { success: false, error: 'command is required to start a terminal' };
      const command = str(a, 'command');
      if (!await authorize(command, c)) return { success: false, error: 'Command denied by execution policy' };
      const { id } = processManager.start(command, c);
      return { success: true, output: id, metadata: { processId: id } };
    }),
    execTool('run_code', 'Execute JavaScript code with Node.js', { code: 'string' }, async (a, c) => {
      const command = `node --input-type=module -e ${shellQuote(str(a, 'code'))}`;
      if (!await authorize(command, c)) return { success: false, error: 'Code execution denied by execution policy' };
      return waitForProcess(processManager.start(command, c).process, timeoutMs, c.signal);
    }),
  ];
  return { tools, processManager };
}

function execTool(
  name: string,
  description: string,
  shape: Record<string, string>,
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>,
): Tool<any> {
  return {
    name, description,
    parameters: {
      type: 'object',
      properties: Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, { type: v.replace('?', '') }])),
      required: Object.entries(shape).filter(([, v]) => !v.endsWith('?')).map(([k]) => k),
      additionalProperties: false,
    },
    validate: (value): value is Record<string, unknown> => value !== null && typeof value === 'object' &&
      !Array.isArray(value) && Object.entries(shape).every(([k, v]) =>
        (v.endsWith('?') && (value as Record<string, unknown>)[k] === undefined) ||
        typeof (value as Record<string, unknown>)[k] === v.replace('?', '')),
    execute,
  };
}

async function waitForProcess(
  process: ManagedProcess,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ToolResult> {
  if (process.exited) return processResult(process);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ToolResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve(result);
    };
    const timer = setTimeout(() => {
      process.child.kill('SIGTERM');
      finish({ success: false, output: process.output, error: 'Execution timed out' });
    }, timeoutMs);
    const abort = () => {
      process.child.kill('SIGTERM');
      finish({ success: false, output: process.output, error: 'Execution cancelled' });
    };
    process.child.once('exit', () => finish(processResult(process)));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function processResult(process: ManagedProcess): ToolResult {
  return {
    success: process.exited?.code === 0,
    output: process.output,
    ...(process.exited?.code === 0 ? {} : { error: `Process exited with code ${process.exited?.code ?? 'unknown'}` }),
    metadata: {
      exitCode: process.exited?.code,
      signal: process.exited?.signal,
      outputTruncated: process.outputTruncated === true,
    },
  };
}

function str(args: Record<string, unknown>, key: string): string {
  return args[key] as string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
