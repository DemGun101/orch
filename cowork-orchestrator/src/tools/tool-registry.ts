import type { ToolDefinition } from '../core/types.js';

// ─── Built-in Tool Definitions ─────────────────────────────────────

const BUILTIN_TOOLS: ToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Read contents of a file',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files in a directory',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'execute_command',
    description: 'Run a shell command',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
  {
    name: 'web_search',
    description: 'Search the web (placeholder)',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
];

// ─── Tool Registry ─────────────────────────────────────────────────

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  constructor() {
    for (const tool of BUILTIN_TOOLS) {
      this.tools.set(tool.name, tool);
    }
  }

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  unregister(toolName: string): void {
    this.tools.delete(toolName);
  }

  get(toolName: string): ToolDefinition | undefined {
    return this.tools.get(toolName);
  }

  getAll(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  search(query: string): ToolDefinition[] {
    const q = query.toLowerCase();
    return this.getAll().filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q),
    );
  }

  /**
   * Validate input against a tool's inputSchema (JSON Schema subset).
   * Checks `type: 'object'`, `required` fields, and per-property `type`.
   */
  validate(toolName: string, input: unknown): boolean {
    const tool = this.tools.get(toolName);
    if (!tool) return false;

    const schema = tool.inputSchema;
    if (schema.type !== 'object' || typeof input !== 'object' || input === null) {
      return false;
    }

    const record = input as Record<string, unknown>;
    const required = (schema.required as string[] | undefined) ?? [];
    for (const key of required) {
      if (!(key in record)) return false;
    }

    const properties = (schema.properties as Record<string, { type?: string }>) ?? {};
    for (const [key, value] of Object.entries(record)) {
      const prop = properties[key];
      if (prop?.type && typeof value !== prop.type) return false;
    }

    return true;
  }

  /** Convert all registered tools to OpenAI function calling format. */
  toOpenAITools(): object[] {
    return this.getAll().map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));
  }
}
