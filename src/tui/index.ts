import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import packageJson from '../../package.json' with { type: 'json' };

const VERSION = packageJson.version;

// Minimal structural type. success/warning/error are new (used by the context bar);
// verify they exist in your pi theme. If one is missing, swap it for accent/muted/dim.
type ThemeColor = 'accent' | 'muted' | 'dim' | 'success' | 'warning' | 'error';
type Theme = { fg(color: ThemeColor, text: string): string };

const RIGHT_W = 34; // right panel width, incl. 1-col padding each side
const WIDE_MIN = RIGHT_W + 40; // box + logo + side panel
const MEDIUM_MIN = 44; // box without logo; below this -> one-liner

// Box/ambiguous-width glyphs break on CJK-locale terminals. BI_ASCII=1 forces safe mode.
const ASCII =
  process.env.BI_ASCII === '1' ||
  process.env.TERM === 'linux' ||
  (process.platform === 'win32' && !process.env.WT_SESSION && !process.env.TERM_PROGRAM);

const G = ASCII
  ? { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|', tT: '+', bT: '+', lT: '+', rT: '+',
      dot: '*', branch: 'git:', dirty: '*', sep: '|',
      inA: '', outA: '', barOn: '#', barOff: '-' }
  : { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│', tT: '┬', bT: '┴', lT: '├', rT: '┤',
      dot: '◆', branch: '⎇', dirty: '●', sep: '·',
      inA: '↓ ', outA: '↑ ', barOn: '▰', barOff: '▱' };

const LOGO = ASCII
  ? [' ____  _ ', '| __ )(_)', '|  _ \\| |', '| |_) | |', '|____/|_|']
  : [
      '██████╗ ██╗',
      '██╔══██╗██║',
      '██████╔╝██║',
      '██╔══██╗██║',
      '██████╔╝██║',
      '╚═════╝ ╚═╝',
    ];

const COMMANDS: Array<[string, string]> = [['/init', 'set up project context']];

// Verify these against your pi version's keybindings.
const KEYS: Array<[string, string]> = [
  ['esc', 'interrupt'],
  ['ctrl+l', 'switch model'],
  ['shift+tab', 'thinking level'],
];

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

/** Two-tone logo: solid blocks in accent, box-drawing "shadow" dimmed. */
function tintLogo(line: string, theme: Theme): string {
  if (ASCII) return theme.fg('accent', line);
  return line
    .replace(/[╔╗╚╝═║]+/g, (m) => theme.fg('dim', m))
    .replace(/█+/g, (m) => theme.fg('accent', m));
}

const kv = (theme: Theme, k: string, v: string, kw = 10) =>
  theme.fg('accent', k.padEnd(kw)) + theme.fg('dim', v);

function title(theme: Theme): { text: string; w: number } {
  const plain = ` Bi v${VERSION} `;
  return { text: theme.fg('accent', ' Bi ') + theme.fg('dim', `v${VERSION} `), w: visibleWidth(plain) };
}

function renderWide(width: number, theme: Theme): string[] {
  const b = (s: string) => theme.fg('dim', s);
  const inner = width - 2;
  const leftW = inner - RIGHT_W - 1;
  const t = title(theme);

  // Pad logo to a uniform width so it centers as a block, not line-by-line.
  const logoW = Math.max(...LOGO.map((l) => visibleWidth(l)));
  const left: string[] = [
    ...LOGO.map((l) => tintLogo(pad(l, logoW), theme)),
    '',
    "Let's build something great",
  ];

  // null = horizontal rule across the right panel.
  const right: (string | null)[] = [
    theme.fg('accent', 'Getting started'),
    theme.fg('dim', 'Describe a task in plain words.'),
    null,
    theme.fg('accent', 'Commands'),
    ...COMMANDS.map(([c, d]) => kv(theme, c, d)),
    null,
    theme.fg('accent', 'Keys'),
    ...KEYS.map(([k, d]) => kv(theme, k, d)),
  ];

  const H = Math.max(left.length, right.length) + 2;
  const lTop = Math.floor((H - left.length) / 2);
  const rTop = Math.floor((H - right.length) / 2);

  const top =
    b(G.tl + G.h) + t.text +
    b(G.h.repeat(Math.max(0, leftW - 1 - t.w)) + G.tT + G.h.repeat(RIGHT_W) + G.tr);
  const bottom = b(G.bl + G.h.repeat(leftW) + G.bT + G.h.repeat(RIGHT_W) + G.br);

  const rows: string[] = [];
  for (let i = 0; i < H; i++) {
    const li = i - lTop;
    const ri = i - rTop;
    const lc = center(li >= 0 && li < left.length ? left[li] : '', leftW);
    const item = ri >= 0 && ri < right.length ? right[ri] : '';
    rows.push(
      item === null
        ? b(G.v) + lc + b(G.lT + G.h.repeat(RIGHT_W) + G.rT)
        : b(G.v) + lc + b(G.v) + ' ' + pad(item, RIGHT_W - 2) + ' ' + b(G.v),
    );
  }
  return ['', top, ...rows, bottom];
}

function renderMedium(width: number, theme: Theme): string[] {
  const b = (s: string) => theme.fg('dim', s);
  const inner = width - 2;
  const t = title(theme);
  const line = (s: string) => b(G.v) + ' ' + pad(s, inner - 2) + ' ' + b(G.v);
  const rule = b(G.lT + G.h.repeat(inner) + G.rT);
  const dsep = theme.fg('dim', `  ${G.sep}  `);

  return [
    '',
    b(G.tl + G.h) + t.text + b(G.h.repeat(Math.max(0, inner - 1 - t.w)) + G.tr),
    line("Let's build something great"),
    rule,
    line(COMMANDS.map(([c]) => theme.fg('accent', c)).join(dsep)),
    line(KEYS.map(([k, d]) => theme.fg('accent', k) + ' ' + theme.fg('dim', d)).join(dsep)),
    b(G.bl + G.h.repeat(inner) + G.br),
  ];
}

// ---------------------------------------------------------------------------
// Footer = port of the Claude Code statusline.
//   one line: model | context bar | prompts | folder + git | tokens in/out |
//             cache R/W (hit%) | session time | cost [| models used]
//   Narrow terminals drop the lowest-priority parts first (see fitJoin priorities).
// ---------------------------------------------------------------------------

const num = (n: number) =>
  n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);

const fmtMs = (ms: number) => {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
};

const shortModel = (id: string) => id.replace(/^claude-/, '').replace(/-\d{8}$/, '');

/** claude-opus-4-5-20251101 -> "Opus 4.5". Unknown ids fall back to a trimmed raw id. */
function prettyModel(id: string): string {
  const m = id.match(/(haiku|sonnet|opus|fable|mythos)-(\d{1,2})(?!\d)(?:-(\d{1,2})(?!\d))?/i);
  if (!m) return shortModel(id);
  return m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() + ' ' + m[2] + (m[3] ? '.' + m[3] : '');
}

type Stats = {
  input: number; output: number; cacheRead: number; cacheWrite: number;
  cost: number; prompts: number; ctxTokens: number; startMs: number; models: string[];
  thinking: string;
};

/**
 * Walks the current branch once. pi stores one usage block per assistant message,
 * so there is no transcript parsing / de-dup / offset cache like the Claude Code script needs.
 * Defensive: the session API shape is not type-checked here.
 */
function sessionStats(ctx: ExtensionContext): Stats {
  const s: Stats = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    cost: 0, prompts: 0, ctxTokens: 0, startMs: 0, models: [], thinking: '',
  };
  try {
    const entries: any[] = (ctx as any).sessionManager?.getBranch?.() ?? [];
    const seen = new Set<string>();
    for (const e of entries) {
      const t = Date.parse(e?.timestamp);
      if (!Number.isNaN(t) && (!s.startMs || t < s.startMs)) s.startMs = t;
      if (e?.type === 'thinking_level_change' && e.thinkingLevel) s.thinking = String(e.thinkingLevel);
      if (e?.type !== 'message') continue;
      const m = e.message;
      if (m?.role === 'user') s.prompts++;
      if (m?.role !== 'assistant' || !m.usage) continue;
      const u = m.usage;
      s.input += u.input ?? 0;
      s.output += u.output ?? 0;
      s.cacheRead += u.cacheRead ?? 0;
      s.cacheWrite += u.cacheWrite ?? 0;
      s.cost += u.cost?.total ?? 0;
      if (m.model) seen.add(String(m.model));
      // Context size ~= everything the last successful call saw plus what it produced.
      const total = (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
      if (total > 0 && m.stopReason !== 'error' && m.stopReason !== 'aborted') s.ctxTokens = total;
    }
    s.models = [...seen];
  } catch {
    /* stats are optional; never break the footer */
  }
  return s;
}

/** Prefers pi's own context accounting if this version exposes it, else last-call estimate. */
function contextInfo(ctx: ExtensionContext, fallbackTokens: number): { pct: number; size: number } {
  let size: number = (ctx as any).model?.contextWindow ?? 0;
  let tokens = fallbackTokens;
  try {
    const cu = (ctx as any).getContextUsage?.();
    if (cu?.contextWindow) {
      size = cu.contextWindow;
      if (typeof cu.tokens === 'number') tokens = cu.tokens;
    }
  } catch {
    /* fall back to estimate */
  }
  const pct = size ? Math.max(0, Math.min(100, Math.floor((tokens / size) * 100))) : 0;
  return { pct, size };
}

type Part = { s: string; p: number }; // p = priority; lowest is dropped first when narrow

/** Joins parts with a divider; drops lowest-priority parts until it fits. Never overflows. */
function fitJoin(parts: Part[], width: number, dsep: string): string {
  let keep = parts.slice();
  const render = () => ' ' + keep.map((k) => k.s).join(dsep);
  while (keep.length > 1 && visibleWidth(render()) + 1 > width) {
    const lowest = keep.reduce((a, b) => (b.p < a.p ? b : a));
    keep = keep.filter((k) => k !== lowest);
  }
  return truncateToWidth(render(), width);
}

/**
 * getThinkingLevel (optional) is the live source, e.g. () => pi.getThinkingLevel().
 * Without it the footer falls back to the last thinking_level_change entry in the session.
 */
export function installTui(ctx: ExtensionContext, getThinkingLevel?: () => string | undefined): void {
  ctx.ui.setHeader((_tui, theme) => ({
    render(width: number): string[] {
      if (width >= WIDE_MIN) return renderWide(width, theme);
      if (width >= MEDIUM_MIN) return renderMedium(width, theme);
      const l = theme.fg('accent', ` ${G.dot} Bi`) + theme.fg('dim', ` v${VERSION}`);
      return [truncateToWidth(l, width)];
    },
    invalidate() {},
  }));

  ctx.ui.setFooter((tui, theme, footerData) => {
    // git dirty flag: polled async. A sync execSync inside render() would block the
    // TUI on every repaint (render fires constantly while streaming).
    let dirty = false;
    let polling = false;
    const pollGit = () => {
      if (polling) return;
      polling = true;
      execFile('git', ['status', '--porcelain'], { cwd: ctx.cwd, timeout: 1500 }, (err, out) => {
        polling = false;
        const next = !err && String(out).trim().length > 0;
        if (next !== dirty) {
          dirty = next;
          tui.requestRender();
        }
      });
    };
    pollGit();

    // Slow tick: refreshes dirty flag and the session timer while idle.
    const tick = setInterval(() => {
      pollGit();
      tui.requestRender();
    }, 5000);
    tick.unref?.();

    const unsubscribe = footerData.onBranchChange(() => {
      pollGit();
      tui.requestRender();
    });

    return {
      dispose() {
        clearInterval(tick);
        unsubscribe();
      },
      invalidate() {},
      render(width: number): string[] {
        const dsep = theme.fg('dim', ` ${G.v} `);
        const s = sessionStats(ctx);
        const branch = footerData.getGitBranch();

        // ---- line 1: model, context, prompts, folder/git ----
        const id = ctx.model?.id;
        let level = s.thinking;
        try {
          level = getThinkingLevel?.() ?? level;
        } catch {
          /* keep session-derived value */
        }
        const levelPart = level
          ? theme.fg('dim', ` ${G.sep} `) + theme.fg(level === 'off' ? 'dim' : 'muted', level)
          : '';
        const modelPart =
          (id ? theme.fg('accent', prettyModel(id)) : theme.fg('dim', 'no model')) + levelPart;

        const { pct, size } = contextInfo(ctx, s.ctxTokens);
        const col: ThemeColor = pct >= 80 ? 'error' : pct >= 50 ? 'warning' : 'success';
        const filled = Math.round(pct / 10);
        const bar = theme.fg(col, G.barOn.repeat(filled)) + theme.fg('dim', G.barOff.repeat(10 - filled));
        const ctxPart =
          `${bar} ${theme.fg(col, pct + '%')}` + (size ? theme.fg('dim', ` of ${num(size)}`) : '');

        const promptPart = theme.fg('dim', 'prompts ') + s.prompts;

        const gitPart =
          (basename(ctx.cwd) || ctx.cwd) +
          (branch
            ? '  ' + theme.fg('accent', `${G.branch} ${branch}`) + (dirty ? theme.fg('warning', ' ' + G.dirty) : '')
            : '');

        // ---- tokens, cache, time, cost ----
        const tIn = s.input + s.cacheRead + s.cacheWrite; // fresh + cache read + cache write
        const hit = tIn ? s.cacheRead / tIn : null;

        const tokensPart =
          theme.fg('accent', G.inA + num(tIn)) + theme.fg('dim', ' in  ') +
          theme.fg('success', G.outA + num(s.output)) + theme.fg('dim', ' out');

        const cachePart =
          theme.fg('dim', 'cache ') + theme.fg('accent', 'R ' + num(s.cacheRead)) + ' ' +
          theme.fg('warning', 'W ' + num(s.cacheWrite)) +
          (hit != null ? theme.fg('dim', ` (${Math.round(hit * 100)}% hit)`) : '');

        const timePart = theme.fg('dim', 'session ') + fmtMs(s.startMs ? Date.now() - s.startMs : 0);
        const costPart = theme.fg('warning', '$' + s.cost.toFixed(3));

        // Display order = Claude Code order. p = drop priority when narrow (lowest goes first).
        const parts: Part[] = [
          { s: modelPart, p: 8 },
          ...(size ? [{ s: ctxPart, p: 6 }] : []),
          { s: promptPart, p: 1 },
          { s: gitPart, p: 5 },
          { s: tokensPart, p: 4 },
          { s: cachePart, p: 3 },
          { s: timePart, p: 2 },
          { s: costPart, p: 7 },
        ];
        // Only shown once more than one model has been used on this branch.
        if (s.models.length > 1) {
          parts.push({ s: theme.fg('dim', s.models.map(shortModel).join(' + ')), p: 0 });
        }

        return [fitJoin(parts, width, dsep)];
      },
    };
  });
}
