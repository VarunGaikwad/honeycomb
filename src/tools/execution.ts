import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Tool, ToolContext, ToolResult } from './types.ts';

interface ManagedProcess {
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

/** Shared process lifecycle for foreground and background execution tools. */
export class ProcessManager {
  private readonly processes = new Map<string, ManagedProcess>();

  start(command: string, context: ToolContext): { id: string; process: ManagedProcess } {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: context.workingDirectory,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const managed: ManagedProcess = { child, output: '' };
    child.stdout?.on('data', (chunk: Buffer) => { managed.output += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { managed.output += chunk.toString(); });
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

export function createExecutionTools(
  manager = new ProcessManager(),
  options: ExecutionOptions = {},
): { tools: Tool<any>[]; processManager: ProcessManager } {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const authorize = async (command: string, context: ToolContext) =>
    options.allowCommand
      ? await options.allowCommand(command, context)
      : !!context.confirmCommand && await context.confirmCommand(command);
  const tools: Tool<any>[] = [
    execTool('bash', 'Run a shell command in the working directory', { command: 'string' }, async (a, c) => {
      const command = str(a, 'command');
      if (!await authorize(command, c)) return { success: false, error: 'Command denied by execution policy' };
      const { process } = manager.start(command, c);
      const result = await waitForProcess(process, timeoutMs, c.signal);
      return result;
    }),
    execTool('background', 'Start a shell command in the background', { command: 'string' }, async (a, c) => {
      const command = str(a, 'command');
      if (!await authorize(command, c)) return { success: false, error: 'Command denied by execution policy' };
      const { id } = manager.start(command, c);
      return { success: true, output: id, metadata: { processId: id } };
    }),
    execTool('process', 'Inspect a managed process and its captured output', { processId: 'string' }, async (a) => {
      const p = manager.get(str(a, 'processId'));
      if (!p) return { success: false, error: 'Process not found' };
      return { success: true, output: p.output, metadata: { running: !p.exited, exitCode: p.exited?.code, signal: p.exited?.signal } };
    }),
    execTool('kill', 'Terminate a managed process', { processId: 'string', force: 'boolean?' }, async (a) => {
      const id = str(a, 'processId');
      const p = manager.get(id);
      if (!p) return { success: false, error: 'Process not found' };
      if (!p.exited) p.child.kill(a.force === true ? 'SIGKILL' : 'SIGTERM');
      return { success: true, output: `Termination requested for ${id}` };
    }),
    execTool('terminal', 'Start an interactive shell process or send input to one', { command: 'string?', processId: 'string?', input: 'string?' }, async (a, c) => {
      if (typeof a.input === 'string') {
        const p = manager.get(str(a, 'processId'));
        if (!p?.child.stdin?.writable) return { success: false, error: 'Terminal process not found or stdin is closed' };
        p.child.stdin.write(a.input);
        return { success: true, output: p.output, metadata: { running: !p.exited } };
      }
      if (typeof a.command !== 'string') return { success: false, error: 'command is required to start a terminal' };
      const command = str(a, 'command');
      if (!await authorize(command, c)) return { success: false, error: 'Command denied by execution policy' };
      const { id } = manager.start(command, c);
      return { success: true, output: id, metadata: { processId: id } };
    }),
    execTool('run_code', 'Execute JavaScript code with Node.js', { code: 'string' }, async (a, c) => {
      const command = `node --input-type=module -e ${shellQuote(str(a, 'code'))}`;
      if (!await authorize(command, c)) return { success: false, error: 'Code execution denied by execution policy' };
      return waitForProcess(manager.start(command, c).process, timeoutMs, c.signal);
    }),
  ];
  return { tools, processManager: manager };
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
    metadata: { exitCode: process.exited?.code, signal: process.exited?.signal },
  };
}

function str(args: Record<string, unknown>, key: string): string {
  return args[key] as string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
