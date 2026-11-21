import { constants, closeSync, lstatSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

export interface StorageOptions {
  generateId?: () => string;
  write?: (fd: number, content: string) => void;
}

/** No protection against concurrent replacement by another same-user process. */
export function savePlan(cwd: string, content: string, signal?: AbortSignal, options: StorageOptions = {}): string {
  if (!path.isAbsolute(cwd) || cwd.split(/[\\/]/).includes("..")) throw new Error("Invalid working directory");
  if (signal?.aborted) throw new Error("Plan save aborted");
  const root = path.parse(cwd).root;
  let current = root;
  for (const part of cwd.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Unsafe working directory");
  }
  for (const part of [".pi", "plans"]) {
    current = path.join(current, part);
    try { mkdirSync(current, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Unsafe plan directory");
  }
  if (signal?.aborted) throw new Error("Plan save aborted");
  const id = (options.generateId ?? randomUUID)();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) throw new Error("Invalid generated plan identifier");
  const destination = path.join(current, `${id}.md`);
  const fd = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  // On failure an incomplete, unreferenced file may remain. Never promote it.
  try {
    (options.write ?? ((file, text) => writeFileSync(file, text, "utf8")))(fd, content);
    if (signal?.aborted) throw new Error("Plan save aborted");
  } finally { closeSync(fd); }
  return destination;
}

/** Only complete saves become candidates for any future approval flow. */
export class PlanStore {
  private current: string | undefined;
  get latest(): string | undefined { return this.current; }
  private readonly options: StorageOptions;
  constructor(options: StorageOptions = {}) { this.options = options; }
  save(cwd: string, content: string, signal?: AbortSignal): string {
    const saved = savePlan(cwd, content, signal, this.options);
    this.current = saved;
    return saved;
  }
  clear(): void { this.current = undefined; }
}
