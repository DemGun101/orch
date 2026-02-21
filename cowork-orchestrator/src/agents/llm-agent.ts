import OpenAI from 'openai';
import type { AgentConfig, Task, TaskResult } from '../core/types.js';
import { BaseAgent } from './base-agent.js';
import type { ChatMessage, ChatTool } from '../llm/client.js';

// ─── Constants ──────────────────────────────────────────────────────

const RETRYABLE_STATUS_CODES = [429, 500, 503];
const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 2000, 4000];

// ─── LLM Agent ──────────────────────────────────────────────────────

export class LLMAgent extends BaseAgent {
  protected client: OpenAI;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;

  constructor(config: AgentConfig, client: OpenAI) {
    super(config);
    this.client = client;
  }

  async execute(task: Task): Promise<TaskResult> {
    const startTime = Date.now();

    try {
      const messages = this.buildMessagesForTask(task);
      const response = await this.callWithRetry(messages);

      const text = response.choices[0]?.message?.content ?? '';
      const toolCalls: Array<{ toolName: string; input: unknown; id: string }> = [];

      if (response.choices[0]?.message?.tool_calls) {
        for (const tc of response.choices[0].message.tool_calls) {
          if (tc.type === 'function') {
            toolCalls.push({
              toolName: tc.function.name,
              input: JSON.parse(tc.function.arguments),
              id: tc.id,
            });
          }
        }
      }

      this.totalInputTokens += response.usage?.prompt_tokens ?? 0;
      this.totalOutputTokens += response.usage?.completion_tokens ?? 0;

      this.history?.addMessage(this.id, 'assistant', text);

      // Trim conversation history if approaching model context limit
      if (this.history) {
        this.history.trimToTokenBudget(this.id, this.getContextTokenLimit());
      }

      const output: Record<string, unknown> = { text };
      if (toolCalls.length > 0) {
        output.toolCalls = toolCalls;
      }

      return {
        taskId: task.id,
        success: true,
        output,
        tokenUsage: {
          input: response.usage?.prompt_tokens ?? 0,
          output: response.usage?.completion_tokens ?? 0,
        },
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

  /** Simple single-turn convenience method */
  async chat(userMessage: string): Promise<string> {
    const response = await this.callWithRetry([
      { role: 'user' as const, content: userMessage },
    ]);

    this.totalInputTokens += response.usage?.prompt_tokens ?? 0;
    this.totalOutputTokens += response.usage?.completion_tokens ?? 0;

    return response.choices[0]?.message?.content ?? '';
  }

  getTokenUsage(): { input: number; output: number } {
    return { input: this.totalInputTokens, output: this.totalOutputTokens };
  }

  protected buildMessagesForTask(task: Task): ChatMessage[] {
    const messages: ChatMessage[] = [];

    // Include conversation history if available
    if (this.history) {
      for (const msg of this.history.getHistory(this.id)) {
        if (msg.role === 'user' || msg.role === 'assistant') {
          messages.push({ role: msg.role, content: msg.content });
        }
      }
    }

    const taskMessage = [
      `Task: ${task.name}`,
      `Description: ${task.description}`,
      `Priority: ${task.priority}`,
      `Input: ${JSON.stringify(task.input)}`,
    ].join('\n');

    messages.push({ role: 'user', content: taskMessage });
    this.history?.addMessage(this.id, 'user', taskMessage);

    return messages;
  }

  protected async callWithRetry(
    messages: ChatMessage[],
    tools?: ChatTool[],
  ): Promise<OpenAI.ChatCompletion> {
    // Prepend system prompt as a system message
    const allMessages: ChatMessage[] = [];
    if (this.config.systemPrompt) {
      allMessages.push({ role: 'system', content: this.config.systemPrompt });
    }
    allMessages.push(...messages);

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.client.chat.completions.create({
          model: this.config.model,
          max_tokens: this.config.maxTokens ?? 4096,
          messages: allMessages,
          ...(tools && tools.length > 0 ? { tools } : {}),
          ...(this.config.temperature !== undefined
            ? { temperature: this.config.temperature }
            : {}),
        }) as OpenAI.ChatCompletion;
      } catch (err: unknown) {
        const status = (err as { status?: number }).status;
        if (status !== undefined && RETRYABLE_STATUS_CODES.includes(status)) {
          if (attempt < MAX_RETRIES) {
            await this.delay(RETRY_DELAYS[attempt] ?? 4000);
            continue;
          }
        }
        throw err;
      }
    }

    throw new Error('Max retries exceeded');
  }

  private getContextTokenLimit(): number {
    const modelLimits: Record<string, number> = {
      'gemini-2.0-flash': 1_000_000,
      'gemini-2.0-pro': 1_000_000,
      'gemini-1.5-flash': 1_000_000,
      'gemini-1.5-pro': 2_000_000,
    };
    const limit = modelLimits[this.config.model] ?? 100_000;
    return Math.floor(limit * 0.8);
  }

  protected delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
