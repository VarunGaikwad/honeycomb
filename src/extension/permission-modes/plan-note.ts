import { constants, promises as fs } from 'node:fs';
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
  // Revalidate after mkdir and immediately before opening. O_NOFOLLOW protects the final component.
  if (planNotePath(cwd, sessionId) !== file) throw new Error('Plan note destination changed');
  const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(content, 'utf8'); } finally { await handle.close(); }
  return file;
}

export async function discardPlanNote(cwd: string, sessionId: string): Promise<void> {
  const file = planNotePath(cwd, sessionId);
  await fs.unlink(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
}
