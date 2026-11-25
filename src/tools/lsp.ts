import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isProtectedWrite, isWithin } from '../extension/permission-modes/paths.ts';
import type { Args, Tool } from '../types/index.ts';
import { object, withLspClient } from './lsp-client.ts';

export const LSP_FLAG = 'bi-lsp-server';
const MAX_FILE = 128 * 1024;
const MAX_RESULTS = 40;
const actions = ['definition', 'references', 'hover', 'diagnostics'] as const;
type Action = typeof actions[number];
type LspArgs = Args & { path: string; language_id: string; action: Action; line?: number; character?: number };

const coordinate = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 0x7fffffff;
export const validLspArgs = (input: unknown): input is LspArgs => {
  const args = object(input);
  return !!args && Object.keys(args).every(key => ['path', 'language_id', 'action', 'line', 'character'].includes(key)) &&
    typeof args.path === 'string' && !!args.path && args.path.length <= 4096 && !args.path.includes('\0') &&
    typeof args.language_id === 'string' && /^[a-zA-Z0-9_+.-]{1,40}$/.test(args.language_id) && actions.includes(args.action as Action) &&
    (args.action === 'diagnostics' ? args.line === undefined && args.character === undefined : coordinate(args.line) && coordinate(args.character));
};

/** Only an existing, explicitly selected executable outside the workspace. */
export async function resolveLspServer(input: unknown, cwd: string): Promise<string | undefined> {
  if (typeof input !== 'string' || !path.isAbsolute(input) || input.includes('\0')) return;
  try {
    const root = await fs.realpath(cwd);
    const executable = await fs.realpath(input);
    if (isWithin(root, executable) || isWithin(path.resolve(cwd), path.resolve(input)) || !(await fs.stat(executable)).isFile()) return;
    await fs.access(executable, constants.X_OK);
    return executable;
  } catch { return undefined; }
}

function allowedPath(root: string, file: string): boolean {
  return isWithin(root, file) && !isProtectedWrite(file) && !path.relative(root, file).split(path.sep)
    .some(part => ['.pi', '.bi'].includes(part.toLowerCase()));
}

async function readSource(file: string): Promise<string> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE) throw new Error('LSP requires a regular workspace file of at most 128 KiB');
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== stat.size || bytes.subarray(0, length).includes(0)) throw new Error('LSP input changed while reading or is not text');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
  } finally { await handle.close(); }
}

export function createLspTool(): Tool<LspArgs> {
  return {
    name: 'lsp', description: 'Query a user-configured local LSP server for definition, references, hover, or diagnostics. Positions are zero-based UTF-16.',
    parameters: { type: 'object', additionalProperties: false, required: ['path', 'language_id', 'action'], properties: {
      path: { type: 'string', maxLength: 4096 }, language_id: { type: 'string', maxLength: 40 }, action: { enum: actions },
      line: { type: 'integer', minimum: 0 }, character: { type: 'integer', minimum: 0 },
    } },
    validate: validLspArgs,
    async execute(args, ctx) {
      if (!ctx.authorizeLsp) return { success: false, error: 'LSP requires a trusted project and an explicitly configured server' };
      const cwd = path.resolve(ctx.workingDirectory);
      const root = await fs.realpath(cwd);
      const requested = path.resolve(cwd, args.path);
      if (!allowedPath(cwd, requested)) return { success: false, error: 'Invalid LSP workspace path' };
      const file = path.join(root, path.relative(cwd, requested));
      if (!allowedPath(root, file) || await fs.realpath(file) !== file) return { success: false, error: 'LSP refuses unsafe or symlinked paths' };
      const server = await ctx.authorizeLsp(file);
      if (!server || await resolveLspServer(server, root) !== server) return { success: false, error: 'LSP query was not approved or server is unavailable' };
      if (await fs.realpath(file) !== file) return { success: false, error: 'LSP path changed after approval' };
      const text = await readSource(file);
      const position = args.action === 'diagnostics' ? undefined : { line: args.line!, character: args.character! };
      if (position) {
        const line = text.split(/\r\n|\n|\r/)[position.line];
        if (line === undefined || position.character > line.length) return { success: false, error: 'LSP position is outside the document' };
      }
      const timeout = AbortSignal.timeout(8_000);
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
      const uri = pathToFileURL(file).href;
      const rootUri = pathToFileURL(root).href;
      const result = await withLspClient(server, root, signal, async client => {
        const initialized = object(await client.request('initialize', {
          processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: path.basename(root) }],
          // Some push servers (including typescript-language-server) opt in only when advertised.
          capabilities: { general: { positionEncodings: ['utf-16'] }, textDocument: {
            diagnostic: { dynamicRegistration: false }, publishDiagnostics: { versionSupport: true },
          } },
        }));
        const capabilities = object(initialized?.capabilities);
        if (!capabilities || (capabilities.positionEncoding !== undefined && capabilities.positionEncoding !== 'utf-16')) throw new Error('LSP server did not initialize with UTF-16 positions');
        client.notify('initialized', {});
        let published: Promise<unknown> | undefined;
        if (args.action === 'diagnostics' && !capabilities.diagnosticProvider) {
          published = new Promise(resolve => client.onNotification(message => {
            const params = object(message.params);
            if (message.method === 'textDocument/publishDiagnostics' && params?.uri === uri &&
                (params.version === undefined || params.version === 1) && Array.isArray(params.diagnostics)) resolve(params.diagnostics);
          }));
        }
        client.notify('textDocument/didOpen', { textDocument: { uri, languageId: args.language_id, version: 1, text } });
        if (args.action === 'diagnostics') return published ?? object(await client.request('textDocument/diagnostic', { textDocument: { uri } }))?.items;
        return client.request(`textDocument/${args.action}`, { textDocument: { uri }, position,
          ...(args.action === 'references' ? { context: { includeDeclaration: true } } : {}) });
      });
      signal.throwIfAborted();
      const output = args.action === 'hover' ? hover(result) : args.action === 'diagnostics' ? diagnostics(result) : await locations(root, result, ctx.canReadLspLocation);
      signal.throwIfAborted();
      return { success: true, output: JSON.stringify(output, null, 2) };
    },
  };
}

function position(value: unknown) {
  const p = object(value);
  return coordinate(p?.line) && coordinate(p.character) ? { line: p.line, character: p.character } : undefined;
}

function range(value: unknown) {
  const r = object(value), start = position(r?.start), end = position(r?.end);
  return start && end ? { start, end } : undefined;
}

async function locations(root: string, result: unknown, canRead?: (file: string) => boolean) {
  const output = [];
  for (const item of (Array.isArray(result) ? result : [result]).slice(0, 200)) {
    const row = object(item);
    const uri = row?.targetUri ?? row?.uri, span = range(row?.targetSelectionRange ?? row?.range);
    if (typeof uri !== 'string' || !uri.startsWith('file:') || !span) continue;
    try {
      const file = fileURLToPath(uri);
      if (!allowedPath(root, file) || await fs.realpath(file) !== file || !(await fs.stat(file)).isFile() || canRead?.(file) === false) continue;
      output.push({ path: path.relative(root, file), range: span });
      if (output.length >= MAX_RESULTS) break;
    } catch { /* Ignore nonlocal, missing, and invalid targets. */ }
  }
  return output;
}

function diagnostics(result: unknown) {
  return (Array.isArray(result) ? result : []).slice(0, MAX_RESULTS).flatMap(item => {
    const row = object(item), span = range(row?.range);
    if (!span || typeof row?.message !== 'string') return [];
    return [{ range: span, message: row.message.slice(0, 500), ...(coordinate(row.severity) ? { severity: row.severity } : {}) }];
  });
}

function hover(result: unknown): string {
  const contents = object(result)?.contents;
  return (Array.isArray(contents) ? contents : [contents]).slice(0, 10).map(item => {
    const text = typeof item === 'string' ? item : object(item)?.value;
    return typeof text === 'string' ? text.slice(0, 4000) : '';
  }).filter(Boolean).join('\n').slice(0, 8000);
}
