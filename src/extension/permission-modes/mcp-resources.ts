export const MCP_RESOURCE_SERVER_FLAG = 'bi-mcp-resource-server';
const resourceTools = new Set(['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']);

export function isMcpResourceTool(tool: string): boolean {
  return resourceTools.has(tool);
}

export function validMcpServerName(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}

function boundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 2048 && !!value.trim() && !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value);
}

export function validMcpResourceArgs(tool: string, args: Record<string, unknown>): boolean {
  if (!Object.hasOwn(args, 'server') || !validMcpServerName(args.server)) return false;
  if (tool === 'read_mcp_resource') return Object.keys(args).length === 2 && Object.hasOwn(args, 'uri') && boundedString(args.uri);
  return Object.keys(args).every(key => key === 'server' || key === 'cursor') &&
    (args.cursor === undefined || boundedString(args.cursor));
}
