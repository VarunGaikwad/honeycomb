import type {
  ExtensionAPI,
  NormalizedBuildSystemPromptOptions,
} from '@earendil-works/pi-coding-agent';
import { BI_CONFIG } from '../config/index.ts';
import { loadProjectConfig } from '../config/project.ts';

function buildBiSystemPrompt(
  options: NormalizedBuildSystemPromptOptions,
  projectInstructions?: string,
): string {
  const parts: string[] = [];

  if (options.customPrompt?.trim()) {
    parts.push(options.customPrompt.trim());
  }
  parts.push(BI_CONFIG.systemPrompt.core.join('\n'));
  if (projectInstructions?.trim()) {
    parts.push(`<project_specific_instructions>\n${projectInstructions.trim()}\n</project_specific_instructions>`);
  }
  parts.push(`Working directory: ${options.cwd}`);

  const tools = options.selectedTools.filter((tool) => !options.hiddenTools.includes(tool));
  if (tools.length > 0) {
    const lines = tools.map((name) => {
      const snippet = options.toolSnippets[name];
      const header = `  - ${name}${snippet ? `: ${snippet}` : ''}`;
      const guidelines = (options.toolGuidelines[name] ?? []).map((rule) => `      - ${rule}`);
      return [header, ...guidelines].join('\n');
    });
    parts.push(`<available_tools>\n${lines.join('\n')}\n</available_tools>`);
  }

  if (options.contextFiles.length > 0) {
    const blocks = options.contextFiles
      .map((file) => `<context_file path="${file.path}">\n${file.content}\n</context_file>`)
      .join('\n');
    parts.push(`<project_context>\n${blocks}\n</project_context>`);
  }

  if (options.skills.length > 0) {
    const lines = options.skills.map((skill) => `  - ${skill.name}: ${skill.description}`);
    parts.push(`<skills>\n${lines.join('\n')}\n</skills>`);
  }

  for (const [tag, content] of Object.entries(options.sections)) {
    if (content.trim()) {
      parts.push(`<${tag}>\n${content.trim()}\n</${tag}>`);
    }
  }

  if (options.appendSystemPrompt.trim()) {
    parts.push(options.appendSystemPrompt.trim());
  }

  return parts.join('\n\n');
}

export function registerSystemInstruction(pi: ExtensionAPI) {
  pi.on('before_agent_start', async (event, ctx) => {
    // Project config is repository content. Only inject its prompt when Pi marks
    // the current project as trusted; the core bi prompt always stays in place.
    const projectInstructions = ctx.isProjectTrusted()
      ? (await loadProjectConfig(event.systemPromptOptions.cwd)).systemPrompt?.additional
      : undefined;
    return { systemPrompt: buildBiSystemPrompt(event.systemPromptOptions, projectInstructions) };
  });
}
