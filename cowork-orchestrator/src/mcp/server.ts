import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerCoworkTools, stopEngine } from './tools.js';

// ─── MCP Server Entry Point ──────────────────────────────────────
// Exposes the cowork orchestrator as an MCP server over stdio.
// Claude Code connects to this server and calls cowork_spawn,
// cowork_status, and cowork_result as tools.

export async function startMCPServer(): Promise<void> {
  const server = new McpServer({
    name: 'cowork-orchestrator',
    description: 'Spawn and orchestrate terminal agents for parallel task execution',
    version: '1.0.0',
  });

  registerCoworkTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Cleanup engine on exit
  const cleanup = async () => {
    await stopEngine();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

// Run directly when executed as the entry point
startMCPServer().catch((error) => {
  process.stderr.write(`Failed to start cowork MCP server: ${error}\n`);
  process.exit(1);
});
