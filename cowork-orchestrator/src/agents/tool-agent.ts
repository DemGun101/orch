import OpenAI from 'openai';
import type { AgentConfig, Task, TaskResult, ToolDefinition } from '../core/types.js';
import { LLMAgent } from './llm-agent.js';
import type { ChatMessage, ChatTool } from '../llm/client.js';
import type { ToolExecutor } from '../tools/tool-executor.js';

// ─── Constants ──────────────────────────────────────────────────────

const MAX_TOOL_ITERATIONS = 10;

// ─── Types ──────────────────────────────────────────────────────────

interface ToolUsageEntry {
  callCount: number;
  errorCount: number;
  totalDuration: number;
}

// ─── Tool Agent ─────────────────────────────────────────────────────

export class ToolAgent extends LLMAgent {
  private tools: ToolDefinition[];
  private toolExecutor: ToolExecutor | null = null;
  private toolUsage = new Map<string, ToolUsageEntry>();

  constructor(config: AgentConfig, client: OpenAI, tools: ToolDefinition[] = []) {
    super(config, client);
    this.tools = [...(config.tools ?? []), ...tools];
  }

  setToolExecutor(executor: ToolExecutor): void {
    this.toolExecutor = executor;
  }

  registerTool(tool: ToolDefinition): void {
    this.tools.push(tool);
  }

  removeTool(toolName: string): void {
    this.tools = this.tools.filter((t) => t.name !== toolName);
  }

  getTools(): ToolDefinition[] {
    return [...this.tools];
  }

  getToolUsageStats(): Record<string, { callCount: number; errorCount: number; avgDuration: number }> {
    const stats: Record<string, { callCount: number; errorCount: number; avgDuration: number }> = {};
    for (const [name, entry] of this.toolUsage) {
      stats[name] = {
        callCount: entry.callCount,
        errorCount: entry.errorCount,
        avgDuration: entry.callCount > 0 ? entry.totalDuration / entry.callCount : 0,
      };
    }
    return stats;
  }

  override async execute(task: Task): Promise<TaskResult> {
    const startTime = Date.now();
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    try {
      const messages: ChatMessage[] = this.buildMessagesForTask(task);
      const apiTools = this.buildApiTools();

      for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
        const response = await this.callWithRetry(messages, apiTools);

        totalInputTokens += response.usage?.prompt_tokens ?? 0;
        totalOutputTokens += response.usage?.completion_tokens ?? 0;

        const choice = response.choices[0];
        const text = choice?.message?.content ?? '';
        const allToolCalls = choice?.message?.tool_calls ?? [];
        const fnCalls = allToolCalls.filter(
          (tc): tc is OpenAI.ChatCompletionMessageFunctionToolCall => tc.type === 'function',
        );

        // If no tool calls or finish_reason is stop, return final result
        if (fnCalls.length === 0 || choice?.finish_reason === 'stop') {
          this.history?.addMessage(this.id, 'assistant', text);

          return {
            taskId: task.id,
            success: true,
            output: { text },
            tokenUsage: { input: totalInputTokens, output: totalOutputTokens },
            duration: Date.now() - startTime,
          };
        }

        // Add the assistant response (with tool_calls) to messages
        messages.push({
          role: 'assistant',
          content: text || null,
          tool_calls: fnCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          })),
        } as ChatMessage);

        // Execute each tool call
        for (const tc of fnCalls) {
          let parsedInput: unknown;
          try {
            parsedInput = JSON.parse(tc.function.arguments);
          } catch {
            parsedInput = tc.function.arguments;
          }

          let content: string;

          if (this.toolExecutor) {
            const result = await this.toolExecutor.execute(tc.function.name, parsedInput);
            this.trackUsage(tc.function.name, result.duration, !result.success);

            content = result.success
              ? JSON.stringify({ result: result.output })
              : JSON.stringify({ error: result.error ?? 'Tool execution failed' });
          } else {
            // Stub fallback when no executor is set
            content = JSON.stringify({
              result: `Stub: Tool "${tc.function.name}" called`,
              input: parsedInput,
            });
          }

          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content,
          } as ChatMessage);
        }
      }

      // Max iterations reached
      return {
        taskId: task.id,
        success: true,
        output: { text: 'Max tool iterations reached', maxIterationsReached: true },
        tokenUsage: { input: totalInputTokens, output: totalOutputTokens },
        duration: Date.now() - startTime,
      };
    } catch (error) {
      return {
        taskId: task.id,
        success: false,
        output: {},
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime,
      };
    }
  }

  private buildApiTools(): ChatTool[] {
    return this.tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: {
          type: 'object' as const,
          ...t.inputSchema,
        },
      },
    }));
  }

  private trackUsage(toolName: string, duration: number, isError: boolean): void {
    const entry = this.toolUsage.get(toolName) ?? { callCount: 0, errorCount: 0, totalDuration: 0 };
    entry.callCount++;
    entry.totalDuration += duration;
    if (isError) entry.errorCount++;
    this.toolUsage.set(toolName, entry);
  }
}
