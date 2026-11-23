import { constants, promises as fs } from 'node:fs';
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

export const MAX_PLAN_BYTES = 64 * 1024;

export async function readPlanNote(cwd: string, sessionId: string): Promise<string | undefined> {
  const file = planNotePath(cwd, sessionId);
  let handle;
  try { handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_PLAN_BYTES || planNotePath(cwd, sessionId) !== file) return undefined;
    const buffer = Buffer.alloc(MAX_PLAN_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    return length <= MAX_PLAN_BYTES ? buffer.toString('utf8', 0, length) : undefined;
  } finally { await handle.close(); }
}

export async function writePlanNote(cwd: string, sessionId: string, content: string): Promise<string> {
  if (Buffer.byteLength(content) > MAX_PLAN_BYTES) throw new Error('Plan note is limited to 64 KiB');
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
