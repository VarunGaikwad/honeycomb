import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { PermissionRules } from './policy.ts';
import { resolvePermissionPath } from './paths.ts';

const groups = ['allow', 'ask', 'deny'] as const;
export function validateRules(value: unknown, trusted: boolean): PermissionRules & { defaultMode?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('configuration must be an object');
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) if (![...groups, 'defaultMode'].includes(key)) throw new Error(`unknown rule field: ${key}`);
  const result: PermissionRules = {};
  for (const key of groups) {
    const list = input[key]; if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > 100 || list.some(x => typeof x !== 'string' || x.length > 500 || !/^[a-zA-Z0-9_]+:.+/.test(x))) throw new Error(`invalid ${key} rules`);
    if (key === 'allow' && !trusted) throw new Error('project configuration cannot define allow rules');
    result[key] = list as string[];
  }
  if (input.defaultMode !== undefined) {
    if (!trusted || !['default','acceptEdits','plan','auto'].includes(String(input.defaultMode))) throw new Error('invalid or untrusted defaultMode');
    (result as PermissionRules & { defaultMode?: string }).defaultMode = String(input.defaultMode);
  }
  return result;
}
function readRulesFile(root: string, relativePath: string): unknown {
  let file = resolvePermissionPath(root, '.');
  for (const component of relativePath.split('/')) {
    file = path.join(file, component);
    if (lstatSync(file).isSymbolicLink()) {
      throw new Error('permission rules path contains a symbolic link');
    }
  }
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error('permission rules must be a regular file with one link');
    }
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally {
    closeSync(fd);
  }
}

export function loadPermissionRules(cwd: string, report: (message: string) => void = console.warn) {
  if (typeof cwd !== 'string' || !cwd) return { rules: {} as PermissionRules, groups: [], defaultMode: undefined as string | undefined, invalid: true };
  let invalid = false;
  const load = (root: string, relativePath: string, trusted: boolean) => {
    try {
      return validateRules(readRulesFile(root, relativePath), trusted);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        invalid = true;
        report(`Invalid permission rules ${path.join(root, relativePath)}: ${String(error)}`);
      }
      return {};
    }
  };
  const user = load(os.homedir(), '.pi/agent/permission-modes.json', true);
  const project = load(cwd, '.pi/permission-modes.json', false);
  return {
    rules: { allow: user.allow, ask: [...(user.ask ?? []), ...(project.ask ?? [])], deny: [...(user.deny ?? []), ...(project.deny ?? [])] },
    groups: [{ label: 'User', rules: user }, { label: 'Project', rules: project }],
    defaultMode: user.defaultMode,
    invalid,
  };
}
