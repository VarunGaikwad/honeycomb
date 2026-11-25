import type { PreviewLine } from '../../tui/permission-dialog.ts';
import { literal } from '../../tui/text.ts';
import { parseWebUrl } from '../../tools/web-fetch.ts';
import { isMcpResourceTool } from './mcp-resources.ts';

const MAX_FILE_PREVIEW = 12_000;
const actions = new Map([
  ['read', 'Read file?'], ['edit', 'Edit file?'], ['write', 'Write file?'], ['apply_patch', 'Apply patch?'],
  ['delete', 'Delete path?'], ['copy', 'Copy path?'], ['move', 'Move path?'], ['mkdir', 'Create directory?'],
]);

function previewText(value: string, color?: PreviewLine['color'], prefix = ''): PreviewLine {
  const clipped = value.length > MAX_FILE_PREVIEW;
  const text = value.slice(0, MAX_FILE_PREVIEW).split('\n').map(line => prefix + line).join('\n');
  return { text: clipped ? `${text}\n[preview truncated]` : text, color };
}

export function previewToolCall(toolName: string, input: Record<string, unknown>): { title: string; preview: PreviewLine[] } {
  if (['bash', 'background', 'terminal'].includes(toolName)) {
    if (typeof input.command === 'string') return {
      title: toolName === 'background' ? 'Start a background command?' : 'Run shell command?',
      preview: [{ text: input.command }],
    };
    if (toolName === 'terminal' && typeof input.input === 'string') return {
      title: 'Send input to terminal?',
      preview: [{ text: `Process: ${literal(String(input.processId))}`, color: 'dim' }, { text: input.input }],
    };
  }
  if (toolName === 'git_add' && Array.isArray(input.paths)) return {
    title: 'Stage Git paths?', preview: input.paths.map(value => ({ text: literal(String(value)) })),
  };
  if (toolName === 'git_checkout' && typeof input.branch === 'string') return {
    title: 'Switch Git branch?', preview: [{ text: literal(input.branch) }],
  };
  if (toolName === 'git_branch' && typeof input.name === 'string') return {
    title: 'Create Git branch?', preview: [{ text: literal(input.name) }],
  };
  if (toolName === 'git_commit' && typeof input.message === 'string') return {
    title: 'Commit staged changes?', preview: [previewText(input.message)],
  };
  if (toolName === 'delete' && typeof input.path === 'string') return {
    title: 'Delete path recursively?', preview: [{ text: `Path: ${literal(input.path)}` }],
  };
  const title = actions.get(toolName) ?? `Allow ${literal(toolName)}?`;
  const preview: PreviewLine[] = [];
  for (const [key, name] of [['path', 'Path'], ['source', 'From'], ['destination', 'To']] as const) {
    const value = input[key];
    if (typeof value === 'string') preview.push({ text: `${name}: ${literal(value)}` });
  }
  if (isMcpResourceTool(toolName)) {
    const read = toolName === 'read_mcp_resource';
    return {
      title: read ? 'Read an MCP resource?' : toolName === 'list_mcp_resource_templates' ? 'List MCP resource templates?' : 'List MCP resources?',
      preview: [{ text: `Server: ${literal(String(input.server))}` },
        ...(read ? [{ text: `URI: ${literal(String(input.uri))}` }] : input.cursor ? [{ text: 'Request the next page.' }] : []),
        { text: read ? 'Pi may return text or images to the model, or save binary content to a temporary file.' : 'Resource metadata goes to the model.' }],
    };
  }
  if (toolName === 'web_search') return {
    title: 'Search the web with Tavily?',
    preview: [{ text: `Query: ${literal(String(input.query))}` },
      { text: 'Tavily receives the query. Returned results go to the model.' }],
  };
  if (toolName === 'web_fetch') return {
    title: 'Fetch a public web page?',
    preview: [{ text: `GET ${literal(parseWebUrl(input.url)?.href ?? '')}` },
      { text: 'The site receives this URL (including its query) and your network address. Returned text goes to the model.' }],
  };
  if (toolName === 'lsp') return {
    title: 'Run a local language server query?',
    preview: [...preview, { text: `Action: ${literal(String(input.action))} (${literal(String(input.language_id))})` },
      ...(typeof input.line === 'number' ? [{ text: `Position: ${input.line}:${input.character} (zero-based UTF-16)` }] : []),
      { text: 'The selected server runs with your local user permissions and receives the workspace path and file contents.' }],
  };
  if (toolName === 'notebook_edit') return {
    title: 'Edit notebook cell source?',
    preview: [...preview, { text: `Cell index: ${Number(input.cell_index)} (zero-based)` },
      previewText(String(input.old_source), 'toolDiffRemoved', '- '),
      previewText(String(input.new_source), 'toolDiffAdded', '+ ')],
  };
  if (toolName === 'write' && typeof input.content === 'string') preview.push(previewText(input.content, 'toolDiffAdded', '+ '));
  if (toolName === 'apply_patch' || toolName === 'edit') {
    const edits = Array.isArray(input.edits) ? input.edits : [input];
    for (const edit of edits.slice(0, 10)) {
      if (!edit || typeof edit !== 'object') continue;
      if (typeof edit.path === 'string' && edit !== input) preview.push({ text: `Path: ${literal(edit.path)}` });
      const before = edit.old_str ?? edit.oldText, after = edit.new_str ?? edit.newText;
      if (edit.replace_all === true || input.replace_all === true) preview.push({ text: 'Replace all matches', color: 'warning' });
      if (typeof before === 'string') preview.push(previewText(before, 'toolDiffRemoved', '- '));
      if (typeof after === 'string') preview.push(previewText(after, 'toolDiffAdded', '+ '));
    }
    if (edits.length > 10) preview.push({ text: `[${edits.length - 10} additional edits not shown]`, color: 'warning' });
  }
  if (!preview.length) preview.push(previewText(JSON.stringify(input, null, 2)));
  return { title, preview };
}
