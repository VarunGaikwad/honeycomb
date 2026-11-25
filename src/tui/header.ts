import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { visibleWidth, type TUI } from '@earendil-works/pi-tui';
import { homedir } from 'node:os';
import { relative, isAbsolute, sep } from 'node:path';
import { BI_CONFIG } from '../config/index.ts';
import packageJson from '../../package.json' with { type: 'json' };
import { ASCII, fit, glyphs as g, literal, pad } from './text.ts';
import { MASCOT_FACE, mascotFrames } from './mascot.ts';

const PANEL_MIN_WIDTH = 70;
const FRAME_MS = 150;
const INTRO_MS = 3000;
const flight = [0, 1, 2, 3, 4, 5, 4, 3, 2, 1];

export function createWelcomeHeader(tui: Pick<TUI, 'requestRender'>, theme: Pick<Theme, 'fg'>, ctx: Pick<ExtensionContext, 'cwd' | 'model'>, cycleKey: string, animate: boolean) {
  let frame = 0;
  let width = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const dispose = () => {
    clearInterval(timer);
    timer = undefined;
    frame = 0;
  };
  if (animate && !ASCII) {
    const started = Date.now();
    timer = setInterval(() => {
      const previous = frame;
      const elapsed = Date.now() - started;
      if (elapsed >= INTRO_MS) dispose();
      else frame = flight[Math.floor(elapsed / FRAME_MS) % flight.length]!;
      if (frame !== previous && width >= PANEL_MIN_WIDTH) tui.requestRender();
    }, FRAME_MS);
    timer.unref?.();
  }
  return {
    dispose,
    invalidate() {},
    render(columns: number) {
      width = columns;
      return renderHeader(columns, theme, ctx.cwd, ctx.model, cycleKey, frame);
    },
  };
}

export function displayCwd(cwd: string): string {
  const part = relative(homedir(), cwd);
  return literal(!part ? '~' : !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`) ? `~${sep}${part}` : cwd);
}

export function displayModel(model?: ExtensionContext['model']): string {
  return literal(model?.name || model?.id || 'No model selected');
}

export function renderHeader(width: number, theme: Pick<Theme, 'fg'>, cwd: string, model?: ExtensionContext['model'], cycleKey = 'shift+tab', frame = 0): string[] {
  if (width < 1) return [];
  const title = theme.fg('accent', 'Honeycomb') + theme.fg('dim', ` v${packageJson.version}`);
  const modelName = theme.fg('muted', displayModel(model));
  const dir = theme.fg('dim', displayCwd(cwd));
  if (width < PANEL_MIN_WIDTH) {
    const mark = width >= visibleWidth(title) + MASCOT_FACE.length + 1 ? MASCOT_FACE : g.mark;
    return [fit(`${theme.fg('accent', mark)} ${title}`, width),
      ...(width >= 18 ? [fit(`  ${modelName}`, width), fit(`  ${dir}`, width)] : [])];
  }

  const leftWidth = Math.min(42, Math.floor((width - 3) * 0.48));
  const rightWidth = width - leftWidth - 3;
  const border = (s: string) => theme.fg('accent', s);
  const left = [theme.fg('text', 'Welcome to Honeycomb!'), ...(mascotFrames[frame] ?? mascotFrames[0]!), '', modelName, dir];
  const { tagline, gettingStartedTitle, gettingStarted, commandsTitle, keysTitle, commands, keys } = BI_CONFIG.ui;
  const right = [theme.fg('accent', gettingStartedTitle), gettingStarted, theme.fg('dim', tagline), '',
    theme.fg('accent', commandsTitle), ...commands.map(({ command, description }) => `${theme.fg('muted', command)} ${description}`), '',
    theme.fg('accent', keysTitle), ...keys.map(({ key, description }) => `${theme.fg('muted', key === 'shift+tab' ? cycleKey : key)} ${description}`)];
  const titleInBorder = ` ${title} `;
  const top = border(g.tl + g.rule) + titleInBorder + border(g.rule.repeat(leftWidth - 1 - visibleWidth(titleInBorder)) + g.top + g.rule.repeat(rightWidth) + g.tr);
  const bottom = border(g.bl + g.rule.repeat(leftWidth) + g.bottom + g.rule.repeat(rightWidth) + g.br);
  const height = Math.max(left.length, right.length);
  const topPadding = Math.floor((height - left.length) / 2);
  const rows = Array.from({ length: height }, (_, i) => border(g.side) + pad(left[i - topPadding] ?? '', leftWidth, true) +
    border(g.side) + ' ' + pad(right[i] ?? '', rightWidth - 2) + ' ' + border(g.side));
  return ['', top, ...rows, bottom];
}
