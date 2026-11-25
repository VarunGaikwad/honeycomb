import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { BI_CONFIG } from '../config/index.ts';
import { CONFIG_LIMITS, OUTPUT_TRUNCATION_MARKER } from '../config/limits.ts';
import type {
  DispatchResult,
  ExecutionOptions,
  ManagedProcess,
  Tool,
  ToolContext,
  ToolResult,
} from '../types/index.ts';

/** Shared process lifecycle for foreground and background execution tools. */
export class ProcessManager {
  private readonly sessions = new Map<string, Map<string, ManagedProcess>>();

  constructor(private readonly maxOutputChars = BI_CONFIG.output.maxChars) {
    validateOutputLimit(maxOutputChars);
  }

  start(command: string, context: ToolContext): { id: string; process: ManagedProcess } {
    context.signal?.throwIfAborted();
    if (!context.sessionId?.trim()) throw new Error('Managed execution requires a session ID');
    const maxOutputChars = context.projectConfig?.output?.maxChars ?? this.maxOutputChars;
    validateOutputLimit(maxOutputChars);
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: context.workingDirectory,
      env: process.env,
      detached: process.platform !== 'win32',
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
    child.on('error', () => { if (!child.pid) managed.exited = { code: null, signal: null }; });
    child.stdin?.on('error', () => { /* The process may close stdin during a write. */ });
    const id = randomUUID();
    const processes = this.sessions.get(context.sessionId) ?? new Map<string, ManagedProcess>();
    processes.set(id, managed);
    this.sessions.set(context.sessionId, processes);
    return { id, process: managed };
  }

  get(id: string, sessionId: string): ManagedProcess | undefined {
    return this.sessions.get(sessionId)?.get(id);
  }

  list(sessionId: string): Array<{ id: string; running: boolean; output: string }> {
    return Array.from(this.sessions.get(sessionId) ?? [], ([id, p]) => ({ id, running: !p.exited, output: p.output }));
  }

  /** This manager belongs to one extension instance; retire all its handles on a Pi boundary. */
  clear(): void {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const processes of sessions) for (const managed of processes.values()) {
      terminate(managed, 'SIGKILL');
      managed.child.stdin?.destroy();
      managed.child.stdout?.destroy();
      managed.child.stderr?.destroy();
    }
  }
}

function terminate(managed: ManagedProcess, signal: NodeJS.Signals): boolean {
  const { child } = managed;
  if (managed.exited || !child.pid) return true;
  try {
    if (process.platform === 'win32') return child.kill(signal);
    process.kill(-child.pid, signal);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
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
    execTool('process', 'Inspect a managed process and its captured output', { processId: 'string' }, async (a, c) => {
      const p = processManager.get(str(a, 'processId'), c.sessionId);
      if (!p) return { success: false, error: 'Process not found' };
      return { success: true, output: p.output, metadata: {
        running: !p.exited,
        exitCode: p.exited?.code,
        signal: p.exited?.signal,
        outputTruncated: p.outputTruncated === true,
      } };
    }),
    execTool('kill', 'Terminate a managed process', { processId: 'string', force: 'boolean?' }, async (a, c) => {
      const id = str(a, 'processId');
      const p = processManager.get(id, c.sessionId);
      if (!p) return { success: false, error: 'Process not found' };
      if (!terminate(p, a.force === true ? 'SIGKILL' : 'SIGTERM')) return { success: false, error: 'Could not terminate the managed process' };
      return { success: true, output: `Termination requested for ${id}` };
    }),
    execTool('terminal', 'Start an interactive shell process or send input to one', { command: 'string?', processId: 'string?', input: 'string?' }, async (a, c) => {
      if (typeof a.input === 'string') {
        if (a.command !== undefined) return { success: false, error: 'Terminal command and input are mutually exclusive' };
        const id = str(a, 'processId');
        const p = processManager.get(id, c.sessionId);
        if (!p?.child.stdin?.writable) return { success: false, error: 'Terminal process not found or stdin is closed' };
        if (!c.confirmCommand || !await c.confirmCommand(`Send terminal input to ${a.processId}:\n${a.input}`)) return { success: false, error: 'Terminal input was not approved' };
        if (c.signal?.aborted || processManager.get(id, c.sessionId) !== p || !p.child.stdin.writable) return { success: false, error: 'Terminal input cancelled or stdin closed' };
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
): Promise<DispatchResult> {
  if (process.exited) return processResult(process);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: DispatchResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      process.child.removeListener('exit', exited);
      process.child.removeListener('error', failed);
      resolve(result);
    };
    const timer = setTimeout(() => {
      terminate(process, 'SIGKILL');
      finish({ success: false, output: process.output, error: 'Execution timed out' });
    }, timeoutMs);
    const abort = () => {
      terminate(process, 'SIGKILL');
      finish({ success: false, error: 'Execution cancelled', errorCode: 'OPERATION_CANCELLED' });
    };
    const exited = () => finish(processResult(process));
    const failed = () => finish({ success: false, error: 'Could not start the managed process' });
    process.child.once('exit', exited);
    process.child.once('error', failed);
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
