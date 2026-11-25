import { spawn } from 'node:child_process';

const MAX_HEADER = 4096;
const MAX_BODY = 1024 * 1024;
const MAX_TRAFFIC = 4 * MAX_BODY;

export function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** One private stdio connection per query. Never services server-initiated requests. */
export async function withLspClient<T>(server: string, cwd: string, signal: AbortSignal, query: (client: {
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  onNotification(handler: (message: Record<string, unknown>) => void): void;
}) => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  const env = Object.fromEntries(['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL']
    .map(key => [key, process.env[key]]).filter(([, value]) => value !== undefined));
  const child = spawn(server, ['--stdio'], { cwd, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'ignore'] });
  let buffer = Buffer.alloc(0), length = 0, traffic = 0, id = 0;
  let error: Error | undefined;
  let notify: ((message: Record<string, unknown>) => void) | undefined;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let rejectConnection!: (error: Error) => void;
  const connectionFailure = new Promise<never>((_, reject) => { rejectConnection = reject; });
  const fail = (reason: string) => {
    if (error) return;
    error = new Error(reason);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    rejectConnection(error);
  };
  const abort = () => fail('LSP query cancelled or timed out');
  const send = (value: object) => {
    if (error) throw error;
    const body = Buffer.from(JSON.stringify(value));
    child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  };
  child.on('error', () => fail('Could not start the LSP server'));
  child.once('close', () => fail('LSP server closed its connection'));
  child.stdin.on('error', () => fail('LSP server input closed'));
  child.stdout.on('error', () => fail('LSP server output closed'));
  child.stdout.on('data', (data: Buffer) => {
    if (error) return;
    traffic += data.length;
    if (traffic > MAX_TRAFFIC) return fail('LSP server output limit exceeded');
    buffer = Buffer.concat([buffer, data]);
    try {
      for (;;) {
        if (!length) {
          const end = buffer.indexOf('\r\n\r\n');
          if (end === -1 && buffer.length <= MAX_HEADER) return;
          if (end === -1 || end > MAX_HEADER) throw new Error();
          const headers = [...buffer.subarray(0, end).toString('ascii').matchAll(/^Content-Length:[ \t]*(\d+)[ \t]*\r?$/gim)];
          length = headers.length === 1 ? Number(headers[0]![1]) : 0;
          if (!length || length > MAX_BODY) throw new Error();
          buffer = buffer.subarray(end + 4);
        }
        if (buffer.length < length) return;
        const message = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))));
        buffer = buffer.subarray(length);
        length = 0;
        if (message?.jsonrpc !== '2.0') throw new Error();
        if (typeof message.method === 'string') {
          if (typeof message.id === 'number' || typeof message.id === 'string') {
            send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Client requests are not supported' } });
          } else if (!Object.hasOwn(message, 'id')) notify?.(message);
        } else if (typeof message.id === 'number') {
          const waiter = pending.get(message.id);
          if (!waiter) continue;
          pending.delete(message.id);
          if (Object.hasOwn(message, 'error') || !Object.hasOwn(message, 'result')) waiter.reject(new Error('LSP server rejected the request'));
          else waiter.resolve(message.result);
        }
      }
    } catch { fail('Invalid or oversized LSP message'); }
  });
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    return await Promise.race([connectionFailure, query({
      request(method, params) {
        return new Promise((resolve, reject) => {
          const next = ++id;
          send({ jsonrpc: '2.0', id: next, method, params });
          pending.set(next, { resolve, reject });
        });
      },
      notify(method, params) { send({ jsonrpc: '2.0', method, params }); },
      onNotification(handler) { notify = handler; },
    })]);
  } finally {
    signal.removeEventListener('abort', abort);
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch { /* The process group may already have exited. */ }
    }
    child.stdin.destroy();
    child.stdout.destroy();
  }
}
