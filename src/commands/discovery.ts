import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import type { PermissionController } from '../extension/permission-modes/index.ts';
import { fit, literal } from '../tui/text.ts';
import { readGoalState } from './goal/state.ts';

export async function show(ctx: ExtensionCommandContext, title: string, rows: string[]) {
  if (!ctx.hasUI) return;
  const safe = rows.slice(0, 200).map(row => literal(row.slice(0, 1000)));
  if (ctx.mode !== 'tui') return ctx.ui.notify(safe.join('\n').slice(0, 8000), 'info');
  await ctx.ui.custom<void>((tui, theme, keys, done) => {
    let offset = 0, page = 1;
    return {
      render(width) {
        page = Math.max(1, tui.terminal.rows - 5);
        offset = Math.max(0, Math.min(offset, safe.length - page));
        return [theme.fg('accent', title), ...safe.slice(offset, offset + page), '↑/↓/PgUp/PgDn: scroll · Esc: close'].map(line => fit(line, width));
      },
      handleInput(data) {
        if (keys.matches(data, 'tui.select.cancel')) return done(undefined);
        if (keys.matches(data, 'tui.select.up')) offset--;
        else if (keys.matches(data, 'tui.select.down')) offset++;
        else if (keys.matches(data, 'tui.select.pageUp')) offset -= page;
        else if (keys.matches(data, 'tui.select.pageDown')) offset += page;
        else return;
        tui.requestRender();
      },
      invalidate() {},
    };
  });
}

export function registerDiscoveryCommands(pi: ExtensionAPI, permissions: PermissionController): void {
  pi.registerCommand('help', {
    description: 'Discover commands and Pi equivalents',
    async handler(args, ctx) {
      const query = args.trim().replace(/^\//, '').toLowerCase();
      const commands = pi.getCommands().filter(c => !query || c.name.toLowerCase() === query);
      const rows = commands.map(c => `${c.source}: /${c.name}${c.description ? ` — ${c.description}` : ''}`);
      if (!query) rows.push('Pi TUI built-ins include /settings, /session, /new, /quit, /model and /hotkeys.', 'Claude equivalents: /clear → /new; /config → /settings; /cost → /session; /exit → /quit.', 'Built-ins are not listed by command discovery and may not be available in RPC.');
      if (!rows.length) rows.push('No discovered command. Pi TUI built-ins are not included in discovery.');
      await show(ctx, 'Command help', rows);
    },
  });
  pi.registerCommand('tool-search', {
    description: 'Search registered tool names and see which are active',
    async handler(args, ctx) {
      if (!ctx.hasUI || !['tui', 'rpc'].includes(ctx.mode)) return;
      const query = args.trim().toLowerCase();
      const active = new Set(pi.getActiveTools());
      const names = [...new Set(pi.getAllTools().map(tool => tool.name))].sort();
      const matches = names.filter(name => name.toLowerCase().includes(query));
      const rows = matches.slice(0, 198).map(name => `${active.has(name) ? 'Active' : 'Inactive'}: ${name}`);
      if (!rows.length) rows.push('No matching registered tools.');
      if (matches.length > 198) rows.push(`Showing 198 of ${matches.length} matches. Refine the search to see more.`);
      rows.unshift('Active means exposed to the model, not pre-approved to run.');
      await show(ctx, 'Tool catalog', rows);
    },
  });
  pi.registerCommand('skills', {
    description: 'List loaded skills and exposed commands',
    async handler(_args, ctx) {
      const skills = ctx.getSystemPromptOptions().skills ?? [];
      const commands = pi.getCommands().filter(c => c.source === 'skill');
      const rows = skills.map(skill => `${skill.name} — ${skill.description}`);
      rows.push(...commands.map(c => `Available command: /${c.name}`));
      await show(ctx, 'Skills', rows.length ? rows : ['No loaded skills or skill commands.']);
    },
  });
  pi.registerCommand('context', {
    description: 'Show context usage and metadata counts',
    async handler(_args, ctx) {
      const usage = ctx.getContextUsage();
      const options = ctx.getSystemPromptOptions();
      await show(ctx, 'Context', [
        `Estimated tokens: ${usage?.tokens ?? 'unknown'}`,
        `Context window: ${usage?.contextWindow ?? 'unknown'}`,
        `Estimated free: ${usage && usage.tokens !== null ? Math.max(0, usage.contextWindow - usage.tokens) : 'unknown'}`,
        `Active tools: ${pi.getActiveTools().length}; context files: ${options.contextFiles?.length ?? 0}; skills: ${options.skills?.length ?? 0}`,
      ]);
    },
  });
  pi.registerCommand('status', {
    description: 'Show local session status',
    async handler(_args, ctx) {
      const goal = readGoalState(ctx.sessionManager.getBranch());
      await show(ctx, 'Status', [
        `Model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : 'none'}`,
        `Project trusted: ${ctx.isProjectTrusted() ? 'yes' : 'no'}`,
        `Permission mode: ${permissions.label}`,
        `Active tools: ${pi.getActiveTools().length}`,
        `Goal: ${goal?.status ?? 'none'}`,
        'More: /doctor, /permissions, /session (Pi TUI).',
      ]);
    },
  });
}
