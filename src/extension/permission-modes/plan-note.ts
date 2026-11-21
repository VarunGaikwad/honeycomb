import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isWithin, resolvePermissionPath } from './paths.ts';

/** Session IDs are opaque; do not permit them to become path components. */
export function planNotePath(cwd: string, sessionId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error('Invalid session ID for plan note');
  const root = resolvePermissionPath(cwd, '.');
  const file = path.join(root, '.pi', 'plans', `${sessionId}.md`);
  const resolved = resolvePermissionPath(root, file);
  if (!isWithin(root, resolved) || resolved !== file) throw new Error('Plan note path contains a symlink or escapes the project');
  return file;
}

export async function writePlanNote(cwd: string, sessionId: string, content: string): Promise<string> {
  const file = planNotePath(cwd, sessionId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${sessionId}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    if (planNotePath(cwd, sessionId) !== file) throw new Error('Plan note destination changed');
    await fs.rename(temporary, file);
  } finally {
    await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }
  return file;
}

export async function discardPlanNote(cwd: string, sessionId: string): Promise<void> {
  const file = planNotePath(cwd, sessionId);
  await fs.unlink(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
}
