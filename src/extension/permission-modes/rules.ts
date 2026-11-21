import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { PermissionRules } from './policy.ts';

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
export function loadPermissionRules(cwd: string, report: (message: string) => void = console.warn) {
  if (typeof cwd !== 'string' || !cwd) return { rules: {} as PermissionRules, defaultMode: undefined as string | undefined, invalid: true };
  let user: PermissionRules & { defaultMode?: string } = {}, project: PermissionRules = {};
  let invalid = false;
  const load = (file: string, trusted: boolean) => { try { return validateRules(JSON.parse(readFileSync(file, 'utf8')), trusted); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') { invalid = true; report(`Invalid permission rules ${file}: ${String(e)}`); } return {}; } };
  user = load(path.join(os.homedir(), '.pi/agent/permission-modes.json'), true);
  project = load(path.join(cwd, '.pi/permission-modes.json'), false);
  return { rules: { allow: user.allow, ask: [...(user.ask ?? []), ...(project.ask ?? [])], deny: [...(user.deny ?? []), ...(project.deny ?? [])] }, defaultMode: user.defaultMode, invalid };
}
