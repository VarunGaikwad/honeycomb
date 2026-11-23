import { lstat, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolvePermissionPath } from './permission-modes/paths.ts';
import { writeUnlinkedFile } from '../tools/write-file.ts';

/** Preserve project settings while optionally enabling Pi's quieter startup by default. */
export async function ensureQuietStartup(cwd: string, autoEnable = true): Promise<void> {
  if (!autoEnable) return;
  const root = resolvePermissionPath(cwd, '.');
  const settingsDir = join(root, '.pi');
  const settingsPath = join(settingsDir, 'settings.json');
  try { if (resolvePermissionPath(root, settingsPath) !== settingsPath) return; } catch { return; }
  let settings: Record<string, unknown> = {};
  try {
    const stat = await lstat(settingsPath);
    if (!stat.isFile() || stat.nlink !== 1) return;
    settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return;
    if (Object.hasOwn(settings, 'quietStartup')) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
  }
  await mkdir(settingsDir, { recursive: true });
  await writeUnlinkedFile(settingsPath, `${JSON.stringify({ ...settings, quietStartup: true }, null, 2)}\n`);
}
