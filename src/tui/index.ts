import { homedir } from 'node:os';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import packageJson from '../../package.json' with { type: 'json' };

const VERSION = packageJson.version;
const RIGHT_W = 30;

// Plain ASCII lettering stays legible in terminals without Unicode block glyphs.
const LOGO = [
  '####   ##',
  '#   #   #',
  '#   #   #',
  '####    #',
  '#   #   #',
  '#   #   #',
  '####   ###',
];

// Commands registered by Bi.
const COMMANDS = ['/init'];

/** ~/code/my-app/src -> …/my-app/src style: home-abbreviated, last two segments only. */
function shortPath(cwd: string): string {
  const home = homedir();
  const p = cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;
  const parts = p.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return p;
  return `…/${parts.slice(-2).join('/')}`;
}

/** Left/right justified line; shrinks left first, drops right only if it must. */
function justify(left: string, right: string, width: number): string {
  const lw = visibleWidth(left);
  const rw = visibleWidth(right);
  if (lw + rw + 1 <= width) return left + ' '.repeat(width - lw - rw) + right;
  if (rw + 4 <= width) return truncateToWidth(left, width - rw - 1) + ' ' + right;
  return truncateToWidth(left, width);
}

function pad(s: string, w: number): string {
  const t = truncateToWidth(s, w);
  return t + ' '.repeat(Math.max(0, w - visibleWidth(t)));
}

function center(s: string, w: number): string {
  const t = truncateToWidth(s, w);
  const gap = Math.max(0, w - visibleWidth(t));
  const l = Math.floor(gap / 2);
  return ' '.repeat(l) + t + ' '.repeat(gap - l);
}

export function installTui(ctx: ExtensionContext): void {
  ctx.ui.setHeader((_tui, theme) => ({
    render(width: number): string[] {
      // Too narrow for the box: compact one-line header.
      if (width < RIGHT_W + 40) {
        const title =
          theme.fg('accent', ' ◆ Bi') + theme.fg('dim', '  ·  ') + theme.fg('muted', 'coding agent');
        return [justify(title, theme.fg('dim', shortPath(ctx.cwd) + ' '), width)];
      }

      const b = (s: string) => theme.fg('accent', s); // border colour
      const inner = width - 2;
      const leftW = inner - RIGHT_W - 1;

      // Top border with title embedded.
      const titleText = ` Bi v${VERSION} `;
      const top =
        b('╭─') +
        theme.fg('accent', ' Bi') +
        theme.fg('dim', ` v${VERSION} `) +
        b('─'.repeat(inner - 1 - titleText.length) + '╮');
      const bottom = b('╰' + '─'.repeat(inner) + '╯');

      // Left panel content (centered).
      const left: string[] = [
        ...LOGO.map((l) => theme.fg('accent', l)),
        '',
        "Let's build something great",
        theme.fg('dim', shortPath(ctx.cwd)),
      ];

      // Right panel content. null = horizontal rule.
      const right: (string | null)[] = [
        theme.fg('accent', 'Getting started'),
        theme.fg('dim', 'Ask Bi to build it'),
        null,
        theme.fg('accent', 'Commands'),
        ...COMMANDS.map((c) => theme.fg('dim', c)),
      ];

      const H = Math.max(left.length, right.length) + 2;
      const lTop = Math.floor((H - left.length) / 2);
      const rTop = Math.floor((H - right.length) / 2);

      const rows: string[] = [];
      for (let i = 0; i < H; i++) {
        const l = i - lTop;
        const r = i - rTop;
        const leftCell = center(l >= 0 && l < left.length ? left[l] : '', leftW);
        const item = r >= 0 && r < right.length ? right[r] : '';
        const isRule = item === null;

        // Divider stops short of the top/bottom border, like the reference.
        const divider = isRule ? b('├') : i === 0 || i === H - 1 ? ' ' : b('│');
        const rightCell = isRule
          ? b('─'.repeat(RIGHT_W) + '┤')
          : ' ' + pad(item ?? '', RIGHT_W - 1) + b('│');

        rows.push(b('│') + leftCell + divider + rightCell);
      }

      return ['', top, ...rows, bottom];
    },
    invalidate() {},
  }));

  ctx.ui.setFooter((tui, theme, footerData) => {
    const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
    return {
      dispose: unsubscribe,
      invalidate() {},
      render(width: number): string[] {
        const branch = footerData.getGitBranch();
        const left = ' ' + (branch ? theme.fg('accent', `⎇ ${branch}`) : theme.fg('dim', 'no git'));
        const model = ctx.model?.id;
        const right =
          (model ? theme.fg('accent', '● ') + theme.fg('muted', model) : theme.fg('dim', '○ no model')) + ' ';
        return [theme.fg('dim', '─'.repeat(width)), justify(left, right, width)];
      },
    };
  });
}