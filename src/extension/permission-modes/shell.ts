import { homedir } from 'node:os';
import path from 'node:path';
import { isProtectedWrite, resolvePermissionPath } from './paths.ts';

export type ShellClassification =
  | { kind: 'read'; paths: string[] }
  | { kind: 'unknown' }
  | { kind: 'deny'; reason: string };

/** Parse a deliberately small shell subset. No expansion or shell operators are accepted. */
function words(command: string): string[] | undefined {
  const result: string[] = [];
  let word = '', started = false, quote: 'single' | 'double' | undefined;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote === 'single') {
      if (ch === "'") quote = undefined; else word += ch;
      started = true;
    } else if (quote === 'double') {
      if (ch === '"') quote = undefined;
      else if ('$`\\'.includes(ch)) return undefined;
      else word += ch;
      started = true;
    } else if (ch === "'" || ch === '"') {
      quote = ch === "'" ? 'single' : 'double'; started = true;
    } else if (' \t'.includes(ch)) {
      if (started) { result.push(word); word = ''; started = false; }
    } else if ('\n\r;&|<>$`(){}*?[]~\\'.includes(ch)) return undefined;
    else { word += ch; started = true; }
  }
  if (quote) return undefined;
  if (started) result.push(word);
  return result;
}

/** Tokenize command words and separators for hard-denial detection only. */
function tokenize(command: string): { segments: string[][]; nested: string[]; outputs: string[]; links: string[] } | undefined {
  const segments: string[][] = [[]];
  const nested: string[] = [], outputs: string[] = [], links: string[] = [];
  let word = '', started = false, complex = false, output = false, quote: 'single' | 'double' | undefined;
  const flush = () => { if (started) { if (output) { outputs.push(word); output = false; } else segments[segments.length - 1]!.push(word); word = ''; started = false; } };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote === 'single') {
      if (ch === "'") quote = undefined; else word += ch;
      started = true; continue;
    }
    if (ch === "'" && !quote) { quote = 'single'; started = true; continue; }
    if (ch === '"') { quote = quote === 'double' ? undefined : 'double'; started = true; continue; }
    if (ch === '\\') {
      if (++i >= command.length) return undefined;
      word += command[i]!; started = true; complex = true; continue;
    }
    if (ch === '$' || ch === '`') {
      // Expansions are never used as evidence of safety. Inspect straightforward
      // substitutions separately for hard denials; all such calls remain unknown.
      complex = true; started = true;
      if (ch === '$' && command[i + 1] === '(') {
        let depth = 1, end = i + 2;
        for (; end < command.length && depth; end++) {
          if (command[end] === '(') depth++;
          else if (command[end] === ')') depth--;
        }
        if (depth) return undefined;
        nested.push(command.slice(i + 2, end - 1)); i = end - 1;
      } else if (ch === '`') {
        const end = command.indexOf('`', i + 1);
        if (end < 0) return undefined;
        nested.push(command.slice(i + 1, end)); i = end;
      }
      word += '?'; continue;
    }
    if (!quote && /[\s;&|<>]/.test(ch)) {
      flush();
      if (!/[ \t]/.test(ch)) {
        complex = true;
        if (ch === '>') { output = true; if (command[i + 1] === '>') i++; }
        if (';&|\n\r'.includes(ch)) {
          if (output) return undefined;
          if (segments[segments.length - 1]!.length) {
            const doubled = command[i + 1] === ch && (ch === '&' || ch === '|');
            links.push(doubled ? ch + ch : ch);
            segments.push([]);
          }
          if (command[i + 1] === ch && (ch === '&' || ch === '|')) i++;
        }
      }
      continue;
    }
    if (!quote && '(){}*?[]~'.includes(ch)) complex = true;
    word += ch; started = true;
  }
  if (quote) return undefined;
  flush();
  if (output) return undefined;
  return { segments, nested, outputs, links };
}

function hardDenial(command: string, cwd: string, depth = 0): string | undefined {
  if (depth > 8) return undefined;
  const parsed = tokenize(command);
  if (!parsed) return undefined;
  for (const nested of parsed.nested) {
    const denial = hardDenial(nested, cwd, depth + 1);
    if (denial) return denial;
  }
  for (const target of parsed.outputs) {
    try {
      const lexical = path.resolve(cwd, target);
      const real = resolvePermissionPath(cwd, target);
      if (lexical === '/dev' || lexical.startsWith('/dev/') || real === '/dev' || real.startsWith('/dev/') || isProtectedWrite(lexical) || isProtectedWrite(real)) return 'protected output destination is blocked';
    } catch { return 'unable to resolve output destination safely'; }
  }
  for (let i = 0; i < parsed.links.length; i++) {
    const source = parsed.segments[i]?.[0]?.split('/').pop();
    const dest = parsed.segments[i + 1]?.[0]?.split('/').pop();
    if (parsed.links[i] === '|' && ['curl', 'wget'].includes(source ?? '') && ['sh', 'bash', 'dash', 'zsh', 'ksh'].includes(dest ?? '')) return 'remote script piped to shell is blocked';
  }
  for (const segment of parsed.segments) {
    let commandIndex = 0;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[commandIndex] ?? '')) commandIndex++;
    if (['env', 'command', 'exec'].includes(segment[commandIndex]?.split('/').pop() ?? '')) {
      commandIndex++;
      while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[commandIndex] ?? '')) commandIndex++;
    }
    const commandWords = segment.slice(commandIndex);
    const name = commandWords[0]?.split('/').pop();
    if (name === 'sudo') return 'sudo is blocked';
    if (name && ['sh', 'bash', 'dash', 'zsh', 'ksh'].includes(name)) {
      const index = commandWords.findIndex((value, i) => i > 0 && /^-[^-]*c/.test(value));
      if (index >= 0 && commandWords[index + 1]) {
        const denial = hardDenial(commandWords[index + 1]!, cwd, depth + 1);
        if (denial) return denial;
      }
    }
    if (name === 'find' && commandWords.some(value => ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf'].includes(value))) return 'mutating find operation cannot be safely classified';
    if (name && ['rm', 'mv', 'cp', 'touch', 'mkdir', 'rmdir', 'truncate', 'shred', 'chmod', 'chown', 'tee'].includes(name)) {
      for (const operand of commandWords.slice(1).filter((value) => !value.startsWith('-'))) {
        try {
          const lexical = path.resolve(cwd, operand);
          const real = resolvePermissionPath(cwd, operand);
          if (isProtectedWrite(lexical) || isProtectedWrite(real) || lexical.startsWith('/dev/') || real.startsWith('/dev/')) return 'protected write destination is blocked';
        } catch { /* The policy rejects unclassified commands. */ }
      }
    }
    if (name === 'git' && commandWords.includes('push') && commandWords.some((v) => /^-[^-]*f/.test(v) || v === '--force' || v.startsWith('--force=') || v === '--force-with-lease' || v.startsWith('--force-with-lease='))) return 'force push is blocked';
    if (name === 'rm' && commandWords.some((v) => v === '--recursive' || (/^-[^-]*[rR]/.test(v))) && commandWords.slice(1).some((v) => v === '~' || path.resolve(cwd, v) === '/' || path.resolve(cwd, v) === homedir())) return 'recursive root or home deletion is blocked';
  }
  return undefined;
}

/** Classification alone never authorizes execution; callers must also validate paths. */
export function classifyShell(command: unknown, cwd = process.cwd()): ShellClassification {
  if (typeof command !== 'string') return { kind: 'unknown' };
  const denial = hardDenial(command, cwd);
  if (denial) return { kind: 'deny', reason: denial };
  const parts = words(command);
  if (!parts?.length) return { kind: 'unknown' };
  const executable = parts[0]!.split('/').pop();
  if (executable === 'sudo') return { kind: 'deny', reason: 'sudo is blocked' };
  // Do not recognize executables through a path or rely on the shell's PATH for scripts.
  if (parts[0] !== executable) return { kind: 'unknown' };
  const operands = parts.slice(1);
  if (executable === 'pwd' && operands.length === 0) return { kind: 'read', paths: [] };
  if (executable === 'grep' && operands.length >= 2 && operands.every((x) => x.length > 0 && !x.startsWith('-'))) {
    return { kind: 'read', paths: operands.slice(1) };
  }
  if ((executable === 'cat' || executable === 'head' || executable === 'tail') && operands.length > 0 && operands.every((x) => x.length > 0 && !x.startsWith('-'))) {
    return { kind: 'read', paths: operands };
  }
  return { kind: 'unknown' };
}
