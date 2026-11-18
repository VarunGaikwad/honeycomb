import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Preserve project settings while optionally enabling Pi's quieter startup by default. */
export async function ensureQuietStartup(cwd: string, autoEnable = true): Promise<void> {
  if (!autoEnable) return;
  const settingsDir = join(cwd, '.pi');
  const settingsPath = join(settingsDir, 'settings.json');
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return;
    if (Object.hasOwn(settings, 'quietStartup')) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
  }
  await mkdir(settingsDir, { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify({ ...settings, quietStartup: true }, null, 2)}\n`, 'utf8');
}
