import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { BI_CONFIG } from '../config/index.ts';
import { needsLspSetup } from '../extension/lsp-menu.ts';
import { getTavilyKey, WEB_SEARCH_FLAG, webSearchSetupTip } from '../tools/web-search.ts';
import { ASCII, fit } from './text.ts';

const WIDGET = 'bi-working-tip';
const lspTip = 'Use /lsp when idle to set up optional code navigation.';
const tips = [
  'Use /tasks when idle to see the current goal and todos.',
  'Use /diff when idle to review staged and unstaged changes.',
  'Use /permissions when idle to inspect rules and recent denials.',
];

function toolLabel(name: string): string {
  if (name === 'read') return 'Reading files';
  if (['ls', 'grep', 'find'].includes(name)) return 'Searching project';
  if (['edit', 'write', 'apply_patch'].includes(name)) return 'Updating files';
  if (['bash', 'background', 'terminal', 'run_code'].includes(name)) return 'Running command';
  if (name.startsWith('git_')) return 'Working with Git';
  return 'Using a tool';
}

export function registerWorkingFeedback(pi: ExtensionAPI, options = BI_CONFIG.ui.workingTips): void {
  let run: {
    ui: ExtensionContext['ui']; tools: Map<string, string>; phase: string;
    replied: boolean; shown: boolean; visible: boolean; lastLabel?: string; tips: string[];
    timer?: ReturnType<typeof setTimeout>;
  } | undefined;
  let waiting = false;
  let tipIndex = 0;

  function hide(current: NonNullable<typeof run>) {
    if (current.timer !== undefined) clearTimeout(current.timer);
    current.timer = undefined;
    if (current.visible) current.ui.setWidget(WIDGET, undefined);
    current.visible = false;
  }

  function refresh() {
    const current = run;
    if (!current) return;
    const labels = new Set(current.tools.values());
    const phase = waiting ? 'Waiting for your input' : labels.size > 1 ? 'Running tools' :
      labels.values().next().value ?? current.phase;
    if (phase !== current.lastLabel) {
      current.ui.setWorkingMessage(`${phase}${ASCII ? '...' : '…'}`);
      current.lastLabel = phase;
    }
    if (waiting || current.replied) hide(current);
    else if (options.enabled && !current.shown && current.timer === undefined) {
      current.timer = setTimeout(() => {
        current.timer = undefined;
        if (run !== current || waiting || current.replied || current.shown) return;
        current.shown = current.visible = true;
        const tip = `Tip: ${current.tips[tipIndex++ % current.tips.length]}`;
        current.ui.setWidget(WIDGET, (_tui, theme) => ({
          render: width => width < 16 ? [] : [theme.fg('dim', fit(tip, width))],
          invalidate() {},
        }));
      }, options.delayMs);
      current.timer.unref();
    }
  }

  function reset() {
    const current = run;
    run = undefined;
    waiting = false;
    if (current) {
      hide(current);
      current.ui.setWorkingMessage();
    }
  }

  pi.on('agent_start', (_event, ctx) => {
    if (ctx.mode !== 'tui') return;
    if (!run) {
      const current = run = { ui: ctx.ui, tools: new Map(), phase: 'Working', replied: false, shown: false, visible: false, tips: [...tips] };
      if (options.enabled && pi.getFlag?.(WEB_SEARCH_FLAG) === true && !getTavilyKey() &&
          pi.getAllTools?.().some(tool => tool.name === 'web_search')) current.tips.unshift(webSearchSetupTip);
      if (options.enabled && pi.getAllTools?.().some(tool => tool.name === 'lsp')) {
        // Probe in the background; starting a run must not wait on the filesystem.
        void needsLspSetup(pi, ctx.cwd).then(missing => {
          if (missing && run === current) current.tips.push(lspTip);
        });
      }
    }
    run.tools.clear();
    run.phase = 'Working';
    refresh();
  });
  pi.on('turn_start', () => {
    if (!run) return;
    run.phase = 'Working';
    refresh();
  });
  pi.on('message_update', event => {
    if (!run) return;
    const type = event.assistantMessageEvent.type;
    if (type === 'thinking_start') run.phase = 'Thinking';
    else if (type === 'text_delta') {
      run.phase = 'Writing reply';
      run.replied = true;
    } else return;
    refresh();
  });
  pi.on('tool_execution_start', event => {
    if (!run || event.parentToolCallId) return;
    run.tools.set(event.toolCallId, toolLabel(event.toolName));
    refresh();
  });
  pi.on('tool_execution_end', event => {
    if (!run?.tools.delete(event.toolCallId)) return;
    run.phase = 'Working';
    refresh();
  });
  pi.on('ui_prompt_start', () => { waiting = true; refresh(); });
  pi.on('ui_prompt_end', () => { waiting = false; refresh(); });
  pi.on('agent_settled', reset);
  pi.on('session_shutdown', reset);
}
