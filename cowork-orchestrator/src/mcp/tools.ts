import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Orchestrator } from '../core/orchestrator.js';
import type { TaskResult } from '../core/types.js';

// ─── Engine Singleton ─────────────────────────────────────────────
let orchestrator: Orchestrator | null = null;
let lastResult: TaskResult | null = null;

export async function stopEngine(): Promise<void> {
  orchestrator = null;
  lastResult = null;
}

// ─── Register MCP Tools ───────────────────────────────────────────

export function registerCoworkTools(server: McpServer): void {
  // ── cowork_spawn ────────────────────────────────────────────────
  server.tool(
    'cowork_spawn',
    'Spawn terminal agents to work on a task in parallel. Decomposes the task via Gemini, opens Windows Terminal tabs with Claude working in each, and returns collected results.',
    {
      prompt: z.string().describe('The task description'),
      agents: z.number().optional().describe('Number of terminal agents (default 3)'),
      model: z.string().optional().describe('Claude model for terminal agents (default claude-sonnet-4-6)'),
    },
    async ({ prompt, agents, model }) => {
      try {
        orchestrator = new Orchestrator({
          maxConcurrency: agents ?? 5,
          defaultModel: model ?? 'claude-sonnet-4-6',
        });

        lastResult = await orchestrator.run(prompt);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: lastResult.success,
                  taskId: lastResult.taskId,
                  duration: lastResult.duration,
                  output: lastResult.output,
                  error: lastResult.error,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error spawning cowork agents: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );

  // ── cowork_status ───────────────────────────────────────────────
  server.tool(
    'cowork_status',
    'Check the status of the cowork orchestration engine, running tasks, and registered agents.',
    {},
    async () => {
      try {
        if (!orchestrator) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  status: 'idle',
                  message: 'No engine running. Call cowork_spawn to start.',
                }),
              },
            ],
          };
        }

        const metrics = orchestrator.getMetrics();

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ status: 'running', metrics }, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error getting status: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );

  // ── cowork_result ───────────────────────────────────────────────
  server.tool(
    'cowork_result',
    'Get the result of a specific completed task by its ID.',
    {
      taskId: z.string().describe('The task ID to fetch results for'),
    },
    async ({ taskId }) => {
      try {
        if (!lastResult) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'No results available. Call cowork_spawn first.',
              },
            ],
          };
        }

        if (lastResult.taskId !== taskId) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Task ${taskId} not found. Last task was ${lastResult.taskId}.`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(lastResult, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error getting task result: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );
}
