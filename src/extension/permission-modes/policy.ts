import path from 'node:path';
import { lstatSync, readdirSync } from 'node:fs';
import { isProtectedWrite, isWithin, resolvePermissionPath } from './paths.ts';
import { classifyShell } from './shell.ts';
import { isMcpResourceTool, validMcpResourceArgs } from './mcp-resources.ts';
import { validNotebookEdit } from '../../tools/notebook.ts';
import { validLspArgs } from '../../tools/lsp.ts';
import { parseWebUrl, validWebFetchArgs } from '../../tools/web-fetch.ts';
import { validWebSearchArgs } from '../../tools/web-search.ts';

export type Decision = { action: 'allow' | 'ask' | 'deny'; reason: string; source?: 'rule' | 'default' | 'boundary' };
export interface PermissionRules { allow?: string[]; ask?: string[]; deny?: string[] }
const result = (action: Decision['action'], reason: string, source: Decision['source'] = 'boundary'): Decision => ({ action, reason, source });

/** Directory operations can affect protected descendants even when the parent is ordinary. */
function containsProtectedDescendant(cwd: string, target: string): boolean {
  const pending = [resolvePermissionPath(cwd, target)];
  let visited = 0;
  while (pending.length) {
    if (++visited > 10000) throw new Error('Directory too large to classify');
    const current = pending.pop()!;
    let stat;
    try { stat = lstatSync(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (isProtectedWrite(child)) return true;
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(child);
    }
  }
  return false;
}

function globExpression(glob: string): RegExp {
  const pattern = [...glob].map(c => c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')).join('');
  return new RegExp(`^${pattern}$`, 's');
}

function matchesRule(tool: string, args: Record<string, unknown>, rule: string, cwd: string): boolean {
  const split = rule.indexOf(':');
  if (split < 1 || rule.slice(0, split) !== tool) return false;
  if (tool === 'web_fetch') return globExpression(rule.slice(split + 1)).test(parseWebUrl(args.url)?.href ?? '');
  if (tool === 'web_search') return globExpression(rule.slice(split + 1)).test(String(args.query));
  if (isMcpResourceTool(tool)) {
    const matches = globExpression(rule.slice(split + 1));
    return [args.server, args.uri].some(value => typeof value === 'string' && matches.test(value));
  }
  const values = ['bash', 'background', 'terminal'].includes(tool) ? [args.command, args.input] : [args.path, args.source, args.destination, ...(Array.isArray(args.edits) ? args.edits.map(edit => edit && typeof edit === 'object' ? (edit as Record<string, unknown>).path : undefined) : [])];
  if (!values.some(value => typeof value === 'string')) values.push(JSON.stringify(args));
  const rulePath = rule.slice(split + 1);
  const patterns = [rulePath];
  if (tool !== 'bash') {
    try {
      const wildcard = rulePath.search(/[*?]/);
      const prefix = wildcard < 0 ? rulePath : rulePath.slice(0, wildcard);
      const base = wildcard < 0 ? prefix : prefix.endsWith('/') ? prefix.slice(0, -1) || '/' : path.dirname(prefix);
      const suffix = wildcard < 0 ? '' : rulePath.slice(base === '.' ? 0 : base.length);
      const resolved = resolvePermissionPath(cwd, base) + suffix;
      patterns.push(resolved, path.relative(resolvePermissionPath(cwd, '.'), resolved));
    } catch { /* Invalid paths are rejected by the path checks below. */ }
  }
  const expressions = patterns.map(globExpression);
  const matches = (value: string) => expressions.some(expression => expression.test(value));
  return values.some(value => {
    if (typeof value !== 'string') return false;
    if (matches(value)) return true;
    if (tool === 'bash') return false;
    try {
      const root = resolvePermissionPath(cwd, '.');
      const lexical = path.resolve(cwd, value);
      const resolved = resolvePermissionPath(cwd, value);
      return [lexical, resolved, path.relative(cwd, lexical), path.relative(root, resolved)].some(matches);
    } catch { return false; }
  });
}

function matchesWriteAllow(cwd: string, tool: string, target: string, rules: string[]): boolean {
  try {
    const root = resolvePermissionPath(cwd, '.');
    const resolved = resolvePermissionPath(cwd, target);
    if (!isWithin(root, resolved)) return false;
    const relative = path.relative(root, resolved);
    return rules.some(rule => {
      if (!rule.startsWith(`${tool}:`)) return false;
      const pattern = rule.slice(tool.length + 1).replace(/^(?:\.\/)+/, '');
      return globExpression(pattern).test(path.isAbsolute(pattern) ? resolved : relative);
    });
  } catch {
    return false;
  }
}

/** Mode gate only: the tool's own validation and authorization still run. */
export function decidePermission(mode: string, toolName: string, input: unknown, cwd: string, rules: PermissionRules = {}): Decision {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof cwd !== 'string' || !cwd)
    return result('deny', 'Invalid tool arguments or working directory');
  const args = input as Record<string, unknown>;
  if (isMcpResourceTool(toolName)) {
    if (!validMcpResourceArgs(toolName, args)) return result('deny', 'MCP resource calls require a server and valid resource arguments');
    if (mode === 'plan' || mode === 'dontAsk') return result('deny', 'This mode blocks MCP resource calls');
    if (rules.deny?.some(rule => matchesRule(toolName, args, rule, cwd))) return result('deny', 'Denied by permission rule', 'rule');
    return result('ask', 'MCP resources require one-time approval');
  }
  if (toolName === 'notebook_edit' && !validNotebookEdit(args)) return result('deny', 'Invalid notebook edit arguments');
  const writes: Record<string, string[]> = { write: ['path'], edit: ['path'], notebook_edit: ['path'], mkdir: ['path'], delete: ['path'], copy: ['destination'], move: ['source', 'destination'] };
  const readTools = ['read', 'ls', 'grep', 'find', 'glob'];
  if (toolName === 'web_search' && !validWebSearchArgs(args)) return result('deny', 'Invalid web search query');
  if (toolName === 'web_fetch' && !validWebFetchArgs(args)) return result('deny', 'Web fetch requires a public HTTPS URL without credentials or a custom port');
  if (toolName === 'lsp' && !validLspArgs(args)) return result('deny', 'Invalid LSP arguments');
  const readPath = toolName === 'lsp' ? args.path : readTools.includes(toolName)
    ? (args.path === undefined && toolName !== 'read' ? '.' : args.path) : undefined;
  const writePaths: unknown[] = (writes[toolName] ?? []).map(field => args[field]);
  const readPaths: unknown[] = readPath === undefined ? [] : [readPath];
  if (readTools.includes(toolName) && readPath === undefined) return result('deny', 'Missing read path');
  if (toolName === 'copy') readPaths.push(args.source);
  if (toolName === 'apply_patch') {
    if (!Array.isArray(args.edits) || !args.edits.length) return result('deny', 'Invalid patch edits');
    for (const edit of args.edits) {
      if (!edit || typeof edit !== 'object' || Array.isArray(edit)) return result('deny', 'Invalid patch edit');
      writePaths.push((edit as Record<string, unknown>).path);
    }
  }
  let outside = false, sensitive = false;
  const check = (target: unknown, write: boolean, workspaceOnly: boolean): Decision | undefined => {
    if (typeof target !== 'string' || !target || target.includes('\0')) return result('deny', 'Invalid path');
    try {
      const root = resolvePermissionPath(cwd, '.');
      const lexical = path.resolve(cwd, target);
      // The filesystem and patch tools resolve relative inputs from the real cwd.
      // Glob, LSP and notebook edits first check the logical workspace path.
      const logicalRoot = ['glob', 'lsp', 'notebook_edit'].includes(toolName);
      const base = workspaceOnly && !logicalRoot ? root : path.resolve(cwd);
      const candidate = path.resolve(base, target);
      if (workspaceOnly && !isWithin(base, candidate)) return result('deny', 'Path is outside the working directory');
      const resolved = resolvePermissionPath(base, candidate);
      if (workspaceOnly && !isWithin(root, resolved)) return result('deny', 'Path is outside the working directory');
      if (isProtectedWrite(lexical) || isProtectedWrite(candidate) || isProtectedWrite(resolved)) {
        if (write) return result('deny', 'Protected path');
        sensitive = true;
      }
      if (!workspaceOnly && (!isWithin(root, lexical) || !isWithin(root, resolved))) outside = true;
    } catch { return result('deny', 'Unable to resolve path safely'); }
  };
  for (const target of writePaths) { const failure = check(target, true, true); if (failure) return failure; }
  for (const target of readPaths) { const failure = check(target, false, true); if (failure) return failure; }
  if (sensitive && ['glob', 'lsp'].includes(toolName)) return result('deny', `${toolName === 'glob' ? 'Glob' : 'LSP'} requires a non-protected workspace path`);
  if (['delete', 'move', 'copy'].includes(toolName)) {
    const target = toolName === 'delete' ? args.path : args.source;
    try {
      if (typeof target !== 'string' || containsProtectedDescendant(cwd, target)) return result('deny', 'Directory contains protected paths');
    } catch { return result('deny', 'Unable to classify directory safely'); }
  }
  if (toolName === 'terminal' && !(typeof args.input === 'string'
    ? args.command === undefined && typeof args.processId === 'string' && !!args.processId
    : args.input === undefined && args.processId === undefined && typeof args.command === 'string'))
    return result('deny', 'Invalid terminal arguments');
  const shellTool = ['bash', 'background', 'terminal'].includes(toolName);
  let shellUnknown = false;
  if (shellTool && typeof args.command === 'string') {
    const shell = classifyShell(args.command, cwd);
    if (shell.kind === 'deny') return result('deny', shell.reason);
    if (shell.kind === 'unknown') shellUnknown = true;
    else for (const operand of shell.paths) { const failure = check(operand, false, false); if (failure) return failure; }
  } else if (toolName === 'bash' || toolName === 'background') return result('deny', 'Missing command');
  if (toolName === 'write' && typeof args.content !== 'string') return result('deny', 'Invalid write content');
  if (toolName === 'plan_note' && typeof args.content !== 'string') return result('deny', 'Invalid plan note content');
  if (toolName === 'apply_patch' && (args.edits as unknown[]).some(edit => {
    const item = edit as Record<string, unknown>;
    return typeof item.oldText !== 'string' || typeof item.newText !== 'string';
  })) return result('deny', 'Invalid patch edit');
  if (toolName === 'edit') {
    const pairs = Array.isArray(args.edits) ? args.edits : [args];
    if (!pairs.length || pairs.some(item => !item || typeof item !== 'object' ||
      !(typeof ((item as Record<string, unknown>).old_str ?? (item as Record<string, unknown>).oldText) === 'string' &&
        typeof ((item as Record<string, unknown>).new_str ?? (item as Record<string, unknown>).newText) === 'string'))) return result('deny', 'Invalid edit arguments');
  }
  if (toolName === 'grep' && typeof (args.query ?? args.pattern) !== 'string') return result('deny', 'Invalid search query');
  if (toolName === 'glob' && (typeof args.pattern !== 'string' || !args.pattern || args.pattern.length > 256)) return result('deny', 'Invalid glob pattern');
  if (toolName === 'find' && typeof (args.name ?? args.pattern) !== 'string') return result('deny', 'Invalid find pattern');
  if (toolName === 'read' && ['offset', 'limit'].some(key => args[key] !== undefined && (typeof args[key] !== 'number' || !Number.isInteger(args[key]) || (args[key] as number) < 1))) return result('deny', 'Invalid read range');
  if (toolName === 'git_commit' && (typeof args.message !== 'string' || !args.message.trim() || args.message.includes('\0'))) return result('deny', 'Invalid commit message');
  if (toolName === 'git_branch' && args.name !== undefined && typeof args.name !== 'string') return result('deny', 'Invalid branch name');
  if (toolName === 'git_diff' && args.staged !== undefined && typeof args.staged !== 'boolean') return result('deny', 'Invalid diff arguments');
  if (toolName === 'git_log' && args.limit !== undefined && (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100)) return result('deny', 'Invalid log limit');
  if (toolName === 'process' && typeof args.processId !== 'string') return result('deny', 'Invalid process ID');
  if (toolName === 'todo' && !['list', 'add', 'complete', 'remove'].includes(String(args.action))) return result('deny', 'Invalid todo action');
  if (toolName === 'plan' && (!Array.isArray(args.steps) || args.steps.some(step => typeof step !== 'string'))) return result('deny', 'Invalid plan steps');
  if (toolName === 'goal_report' && (!['continue', 'completed', 'blocked'].includes(String(args.status)) || typeof args.summary !== 'string' || !args.summary.trim())) return result('deny', 'Invalid goal report');
  if (toolName === 'ask_user' && (!Array.isArray(args.questions) || !args.questions.length)) return result('deny', 'Invalid questions');
  const listBranches = toolName === 'git_branch' && args.name === undefined;
  if (mode === 'plan' && !listBranches && ![...readTools, 'git_status', 'git_diff', 'git_log', 'goal_report', 'todo', 'plan', 'ask_user', 'plan_note'].includes(toolName))
    return result('deny', 'Plan mode blocks mutation, execution and delegation');
  const matches = (items?: string[]) => items?.some(rule => matchesRule(toolName, readPath === undefined ? args : { ...args, path: readPath }, rule, cwd)) ?? false;
  if (matches(rules.deny)) return result('deny', 'Denied by permission rule', 'rule');
  if (toolName === 'web_search') return mode === 'dontAsk'
    ? result('deny', 'No prompts mode blocks web search')
    : result('ask', 'Tavily web search requires one-time approval');
  if (toolName === 'web_fetch') return mode === 'dontAsk'
    ? result('deny', 'No prompts mode blocks web fetch')
    : result('ask', 'Public web fetch requires one-time approval');
  if (toolName === 'lsp' && rules.deny?.some(rule => matchesRule('read', { path: args.path }, rule, cwd))) return result('deny', 'LSP source file is restricted by read policy');
  if (matches(rules.ask)) return result(mode === 'dontAsk' ? 'deny' : 'ask', 'Requires approval by permission rule', 'rule');
  if (shellUnknown) return result(mode === 'dontAsk' ? 'deny' : 'ask', 'Unclassified shell command requires approval');
  if (sensitive || outside) return result(mode === 'dontAsk' ? 'deny' : 'ask', 'Sensitive or outside path requires approval');
  // Recursive grep reads every file, including credentials nested below the root.
  if (toolName === 'grep') return result(mode === 'dontAsk' ? 'deny' : 'ask', 'Recursive search may read sensitive files');
  if (mode === 'dontAsk' && toolName === 'ask_user') return result('deny', 'No prompts mode blocks interactive questions');
  if (toolName === 'plan_note') return mode === 'plan' ? result('allow', 'Session plan note') : result('deny', 'Plan note is available only in Plan mode');
  if (listBranches || [...readTools, 'git_status', 'git_diff', 'git_log', 'goal_report', 'todo', 'plan', 'ask_user', 'process'].includes(toolName)) return result('allow', 'Read or session bookkeeping');
  const ordinaryEdit = ['write', 'edit', 'mkdir', 'apply_patch', 'copy', 'move'].includes(toolName);
  if (ordinaryEdit && writePaths.length === 1 && readPaths.length === 0 && rules.allow &&
      matchesWriteAllow(cwd, toolName, writePaths[0] as string, rules.allow)) {
    return result('allow', 'Allowed by trusted user rule', 'rule');
  }
  if (ordinaryEdit && ['acceptEdits', 'auto'].includes(mode)) return result('allow', 'Project edit', 'default');
  if (mode === 'bypassPermissions' && (ordinaryEdit || toolName === 'delete' || (shellTool && typeof args.command === 'string'))) return result('allow', 'Bypass mode', 'default');
  if (mode === 'dontAsk') return result('deny', 'Permission requires confirmation');
  return result('ask', 'Permission requires confirmation', 'default');
}
