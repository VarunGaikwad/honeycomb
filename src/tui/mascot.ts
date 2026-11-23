import { ASCII } from './text.ts';

// Pixel grid from the 22px rectangles in assets/pixel_honeybee_mascot.svg (shadow omitted).
const pixels = [
  '     D    D     ',
  '      D  D      ',
  ' BBB DDDDDD BBB ',
  'BLLLDYYYYYYDLLLB',
  'BLLDYWDYYWDYDLLB',
  'BLLDYDDYYDDYDLLB',
  ' BBDYYYDDYYYDBB ',
  '  DYYYYYYYYYYD  ',
  '  DDDDDDDDDDDD  ',
  '  DYYYYYYYYYYD  ',
  '  DDDDDDDDDDDD  ',
  '   DDYYYYYYDD   ',
  '    DDDDDDDD    ',
  '       DD       ',
];
const colors: Record<string, number> = { B: 111, L: 255, D: 58, Y: 220, W: 231 };

export const MASCOT_FACE = '<(o.o)>';
export const mascotLines = ASCII ? [
  '    \\  /    ',
  ' .-(o  o)-. ',
  " '<| -- |>' ",
  '   |====|   ',
  '    \\==/    ',
  '      v     ',
] : pixels.filter((_, row) => row % 2 === 0).map((top, row) =>
  Array.from(top, (pixel, col) => {
    const fg = colors[pixel];
    const bg = colors[pixels[row * 2 + 1]?.[col] ?? ' '];
    if (fg === undefined && bg === undefined) return ' ';
    if (fg === undefined) return `\x1b[38;5;${bg}m▄\x1b[39m`;
    return `\x1b[38;5;${fg}${bg === undefined ? '' : `;48;5;${bg}`}m▀\x1b[39;49m`;
  }).join(''),
);
