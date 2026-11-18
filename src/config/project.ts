import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BI_CONFIG } from './index.ts';
import { CONFIG_LIMITS } from './limits.ts';

/** Safe per-project preferences; command and destructive-operation policies are not configurable here. */
export interface ProjectConfig {
  filesystem?: {
    defaultReadLimit?: number;
    maxReadLineLength?: number;
    maxGrepMatches?: number;
  };
  git?: {
    defaultLogLimit?: number;
  };
  output?: {
    maxChars?: number;
  };
  startup?: {
    autoEnableQuietStartup?: boolean;
  };
  systemPrompt?: {
    additional?: string;
  };
}

const MAX_CONFIG_BYTES = 64 * 1024;

/** Create starter project preferences once, leaving an existing config untouched. */
export async function ensureProjectConfig(cwd: string): Promise<void> {
  const directory = join(cwd, '.pi');
  const file = join(directory, 'config.json');
  const defaults: ProjectConfig = {
    filesystem: BI_CONFIG.filesystem,
    git: BI_CONFIG.git,
    output: BI_CONFIG.output,
    startup: BI_CONFIG.startup,
    systemPrompt: { additional: '' },
  };
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(file, `${JSON.stringify(defaults, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    // Existing files (including concurrent session startup) and unavailable project storage are left alone.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
  }
}

/** Load only allowlisted, bounded preferences from the active project's .pi/config.json. */
export async function loadProjectConfig(cwd: string): Promise<ProjectConfig> {
  const file = join(cwd, '.pi', 'config.json');
  try {
    const fileStat = await stat(file);
    if (!fileStat.isFile() || fileStat.size > MAX_CONFIG_BYTES) return {};
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    const root = record(parsed);
    if (!root) return {};

    const filesystem = record(root.filesystem);
    const git = record(root.git);
    const output = record(root.output);
    const startup = record(root.startup);
    const systemPrompt = record(root.systemPrompt);
    const result: ProjectConfig = {};

    const defaultReadLimit = boundedInteger(filesystem?.defaultReadLimit, 1, CONFIG_LIMITS.maxReadLimit);
    const maxReadLineLength = boundedInteger(
      filesystem?.maxReadLineLength,
      CONFIG_LIMITS.minReadLineLength,
      CONFIG_LIMITS.maxReadLineLength,
    );
    const maxGrepMatches = boundedInteger(filesystem?.maxGrepMatches, 1, CONFIG_LIMITS.maxGrepMatches);
    if (defaultReadLimit !== undefined || maxReadLineLength !== undefined || maxGrepMatches !== undefined) {
      result.filesystem = {
        ...(defaultReadLimit !== undefined ? { defaultReadLimit } : {}),
        ...(maxReadLineLength !== undefined ? { maxReadLineLength } : {}),
        ...(maxGrepMatches !== undefined ? { maxGrepMatches } : {}),
      };
    }

    const defaultLogLimit = boundedInteger(git?.defaultLogLimit, 1, CONFIG_LIMITS.maxGitLogLimit);
    if (defaultLogLimit !== undefined) result.git = { defaultLogLimit };

    const maxChars = boundedInteger(output?.maxChars, CONFIG_LIMITS.minOutputChars, CONFIG_LIMITS.maxOutputChars);
    if (maxChars !== undefined) result.output = { maxChars };

    if (typeof startup?.autoEnableQuietStartup === 'boolean') {
      result.startup = { autoEnableQuietStartup: startup.autoEnableQuietStartup };
    }

    if (typeof systemPrompt?.additional === 'string' &&
      systemPrompt.additional.length <= CONFIG_LIMITS.maxProjectPromptChars) {
      result.systemPrompt = { additional: systemPrompt.additional };
    }
    return result;
  } catch {
    // A missing or invalid project config must not prevent normal tool execution.
    return {};
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  return Number.isInteger(value) && (value as number) >= minimum && (value as number) <= maximum
    ? value as number
    : undefined;
}
