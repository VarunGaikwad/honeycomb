import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

export const ASCII =
  process.env.BI_ASCII === '1' ||
  process.env.TERM === 'linux' ||
  (process.platform === 'win32' && !process.env.WT_SESSION && !process.env.TERM_PROGRAM);

export const glyphs = ASCII
  ? {
      pointer: '>  ',
      rule: '-',
      side: '|',
      tl: '+',
      tr: '+',
      bl: '+',
      br: '+',
      top: '+',
      bottom: '+',
      mark: '*',
      sep: '|',
    }
  : {
      pointer: '❯',
      rule: '─',
      side: '│',
      tl: '╭',
      tr: '╮',
      bl: '╰',
      br: '╯',
      top: '┬',
      bottom: '┴',
      mark: '✦',
      sep: '·',
    };

/** Render untrusted metadata literally, including ANSI and direction-changing controls. */
export function literal(text: string, multiline = false): string {
  return text.replace(/[\p{Cc}\u061c\u200e\u200f\u2028-\u202e\u2066-\u206f]/gu, (char) => {
    if (char === '\n') return multiline ? char : '\\n';
    if (char === '\r') return '\\r';
    if (char === '\t') return '\\t';
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
}

export function pad(text: string, width: number, centered = false): string {
  const clipped = truncateToWidth(text, width, ASCII ? '...' : '…');
  const gap = Math.max(0, width - visibleWidth(clipped));
  const left = centered ? Math.floor(gap / 2) : 0;
  return ' '.repeat(left) + clipped + ' '.repeat(gap - left);
}

export function fit(text: string, width: number): string {
  return truncateToWidth(text, Math.max(0, width), ASCII ? '...' : '…');
}
