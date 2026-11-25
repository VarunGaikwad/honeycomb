import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

export function footerStats(entries: ReturnType<ExtensionContext['sessionManager']['getEntries']>) {
  let input = 0, output = 0, read = 0, write = 0, cost = 0, prompts = 0, duration = 0, timed = 0, assistants = 0;
  const models = new Set<string>();
  for (const entry of entries) {
    let usage: Extract<(typeof entries)[number], { type: 'usage' }>['usage'] | undefined;
    if (entry.type === 'message') {
      const message = entry.message;
      if (message.role === 'user') prompts++;
      if (message.role === 'assistant') {
        assistants++;
        models.add(`${message.provider}/${message.model}`);
        if (typeof message.durationMs === 'number') { duration += message.durationMs; timed++; }
        usage = message.usage;
      } else if (message.role === 'toolResult') usage = message.usage;
    } else if (entry.type === 'usage' || entry.type === 'compaction' || entry.type === 'branch_summary') {
      usage = entry.usage;
      if (entry.type === 'usage') models.add(`${entry.provider}/${entry.model}`);
    }
    if (!usage) continue;
    input += usage.input || 0; output += usage.output || 0;
    read += usage.cacheRead || 0; write += usage.cacheWrite || 0;
    cost += usage.cost?.total || 0;
  }
  return { input: input + read + write, output, read, write, cost, prompts, duration, timed, assistants, models: [...models] };
}

export function compactNumber(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}
export function durationText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m${seconds % 60}s` : `${Math.floor(seconds / 3600)}h${Math.floor(seconds / 60) % 60}m`;
}
