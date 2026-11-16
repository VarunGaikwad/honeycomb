import type { Tool } from '../types/index.ts';

export class ToolRegistry {
  private readonly tools = new Map<string, Tool<any>>();

  register(tool: Tool<any>): void {
    if (!tool.name.trim()) throw new Error('Tool name must not be empty');
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): Tool<any> | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): Tool<any>[] {
    return [...this.tools.values()];
  }

  definitions(): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
    return this.list().map(({ name, description, parameters }) => ({ name, description, parameters }));
  }
}
