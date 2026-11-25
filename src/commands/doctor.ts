import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { BI_CONFIG } from '../config/index.ts';
import { loadProjectConfig, type ProjectConfig } from '../config/project.ts';
import { loadPermissionRules } from '../extension/permission-modes/rules.ts';
import type { PermissionController } from '../extension/permission-modes/index.ts';
import { hasBiPromptEditor } from '../tui/editor.ts';
import { fit, literal } from '../tui/text.ts';

const exec = promisify(execFile);

export function doctorPreferences(project: ProjectConfig, trusted: boolean): string[] {
  const rows: string[] = [];
  for (const section of ['filesystem', 'git', 'output', 'startup'] as const) {
    const overrides = project[section] as Record<string, number | boolean> | undefined;
    for (const [key, fallback] of Object.entries(BI_CONFIG[section])) {
      const override = overrides?.[key];
      rows.push(`${section}.${key}: ${override ?? fallback} (${override === undefined ? 'package default' : 'project'})`);
    }
  }
  rows.push(`Project instructions: ${project.systemPrompt?.additional ? trusted ? 'configured' : 'ignored (untrusted project)' : 'not configured'}`);
  return rows;
}

export function registerDoctorCommand(pi: ExtensionAPI, permissions: PermissionController): void {
  pi.registerCommand('doctor', {
    description: 'Inspect Honeycomb configuration, permission health, tool groups, and Git',
    async handler(_args, ctx) {
      if (!ctx.hasUI) return;
      if (!ctx.isIdle()) return ctx.ui.notify('Wait for the current run before opening /doctor.', 'warning');
      const issues: string[] = [];
      const rules = loadPermissionRules(ctx.cwd, message => {
        // The existing loader includes raw parser exceptions. Never display those.
        const source = message.startsWith(`Invalid permission rules ${ctx.cwd}/.pi/`) ? 'project' : 'user';
        issues.push(`Blocked: invalid ${source} permission rules. See /permissions.`);
      });
      const configIssues: string[] = [];
      const project = await loadProjectConfig(ctx.cwd, issue => configIssues.push(`Warning: ${issue}`));
      const active = new Set(pi.getActiveTools());
      const inactive = pi.getAllTools().filter(tool => !active.has(tool.name)).map(tool => literal(tool.name));
      const groups = Object.entries(BI_CONFIG.toolGroups).filter(([, enabled]) => !enabled).map(([name]) => name);
      let git = 'OK: Git available';
      try { await exec('git', ['--version'], { cwd: ctx.cwd, timeout: 1500, maxBuffer: 4096 }); }
      catch { git = 'Warning: could not run Git. Check that Git is installed and on PATH.'; }
      const rows = [
        `Permission mode: ${permissions.label}`, ...(issues.length ? issues : ['OK: permission rules']), git,
        `Disabled Honeycomb tool groups: ${groups.join(', ') || 'none'}`,
        `Registered but inactive tools: ${inactive.slice(0, 30).join(', ') || 'none'}${inactive.length > 30 ? '…' : ''}`,
        ...configIssues, ...doctorPreferences(project, ctx.isProjectTrusted()), 'Effective keyboard shortcuts: see /hotkeys.',
      ];
      if (ctx.mode !== 'tui') return ctx.ui.notify(rows.join('\n'), rules.invalid ? 'warning' : 'info');
      await ctx.ui.custom<void>((tui, theme, keys, done) => {
        const thinking = keys.getKeys('app.thinking.cycle');
        if (hasBiPromptEditor(ctx)) {
          rows.push('Honeycomb editor active: Shift+Tab cycles permissions outside autocomplete.');
          if (thinking.includes('shift+tab')) rows.push('Shift+Tab thinking binding is intercepted; use Alt+T for thinking.');
        } else rows.push('Honeycomb editor not active: use Alt+M to cycle permissions.');
        let offset = 0, page = 1;
        return {
          render(width) {
            page = Math.max(1, tui.terminal.rows - 5);
            offset = Math.max(0, Math.min(offset, rows.length - page));
            return [theme.fg('accent', 'Honeycomb diagnostics'), ...rows.slice(offset, offset + page), '↑/↓/PgUp/PgDn: scroll · Esc: close'].map(line => fit(line, width));
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
    },
  });
}
