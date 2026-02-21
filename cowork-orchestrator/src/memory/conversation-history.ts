import type OpenAI from 'openai';
import { getDefaultModel } from '../llm/client.js';
import type { PersistenceLayer } from './persistence.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface ConversationMessage {
  role: string;
  content: string;
  timestamp: Date;
}

// ─── Conversation History ───────────────────────────────────────────

export class ConversationHistory {
  private histories = new Map<string, ConversationMessage[]>();
  private persistence?: PersistenceLayer;

  constructor(persistence?: PersistenceLayer) {
    this.persistence = persistence;
  }

  addMessage(agentId: string, role: string, content: string): void {
    if (!this.histories.has(agentId)) {
      this.histories.set(agentId, []);
    }
    const msg: ConversationMessage = { role, content, timestamp: new Date() };
    this.histories.get(agentId)!.push(msg);
    this.persistence?.saveConversationMessage(
      agentId,
      role,
      content,
      msg.timestamp.toISOString(),
    );
  }

  getHistory(agentId: string, limit?: number): ConversationMessage[] {
    const history = this.histories.get(agentId) ?? [];
    if (limit && history.length > limit) {
      return history.slice(-limit);
    }
    return [...history];
  }

  /** Estimate token count (rough: chars / 4) */
  getTokenCount(agentId: string): number {
    const history = this.histories.get(agentId) ?? [];
    return history.reduce((sum, msg) => sum + Math.ceil(msg.content.length / 4), 0);
  }

  /**
   * Remove oldest messages to fit within token budget.
   * Always preserves the first message (system prompt).
   */
  trimToTokenBudget(agentId: string, maxTokens: number): void {
    const history = this.histories.get(agentId);
    if (!history || history.length <= 1) return;

    const systemMessage = history[0];
    let currentTokens = this.getTokenCount(agentId);
    let removeCount = 0;

    while (currentTokens > maxTokens && removeCount < history.length - 1) {
      removeCount++;
      currentTokens -= Math.ceil(history[removeCount].content.length / 4);
    }

    if (removeCount > 0) {
      this.histories.set(agentId, [systemMessage, ...history.slice(removeCount + 1)]);
    }
  }

  /**
   * Summarize conversation history.
   * If an OpenAI client is provided, uses AI-powered summarization.
   * Otherwise, returns a placeholder summary.
   */
  async summarize(agentId: string, client?: OpenAI): Promise<string> {
    const history = this.histories.get(agentId) ?? [];
    const tokenCount = this.getTokenCount(agentId);

    if (!client || history.length === 0) {
      return `[Conversation summary: ${history.length} messages, ~${tokenCount} tokens.]`;
    }

    const conversationText = history
      .map((m) => `${m.role}: ${m.content}`)
      .join('\n');

    const response = await client.chat.completions.create({
      model: getDefaultModel(),
      max_tokens: 1024,
      messages: [
        {
          role: 'system',
          content:
            'Summarize this conversation concisely, preserving key decisions, facts, and context needed for continuation.',
        },
        {
          role: 'user',
          content: conversationText,
        },
      ],
    }) as OpenAI.ChatCompletion;

    return response.choices[0]?.message?.content?.trim() ?? `[Summary: ${history.length} messages]`;
  }

  /**
   * Compress history by summarizing older messages while keeping recent ones intact.
   * Replaces older messages with a single summary message to fit within token budget.
   */
  async compressHistory(
    agentId: string,
    targetTokens: number,
    client?: OpenAI,
  ): Promise<void> {
    const history = this.histories.get(agentId);
    if (!history || history.length <= 2) return;

    const currentTokens = this.getTokenCount(agentId);
    if (currentTokens <= targetTokens) return;

    // Keep the system message (first) and recent messages
    const systemMessage = history[0];
    const tokensToFree = currentTokens - targetTokens;

    // Find how many old messages to summarize (skip system at index 0)
    let freedTokens = 0;
    let summarizeUpTo = 1;
    while (summarizeUpTo < history.length - 1 && freedTokens < tokensToFree) {
      freedTokens += Math.ceil(history[summarizeUpTo].content.length / 4);
      summarizeUpTo++;
    }

    if (summarizeUpTo <= 1) return;

    const oldMessages = history.slice(1, summarizeUpTo);
    const recentMessages = history.slice(summarizeUpTo);

    // Generate summary of old messages
    let summaryContent: string;
    if (client) {
      const oldText = oldMessages
        .map((m) => `${m.role}: ${m.content}`)
        .join('\n');

      const response = await client.chat.completions.create({
        model: getDefaultModel(),
        max_tokens: 512,
        messages: [
          {
            role: 'system',
            content:
              'Summarize this conversation fragment concisely, preserving key decisions, facts, and context needed for continuation. Keep it brief.',
          },
          {
            role: 'user',
            content: oldText,
          },
        ],
      }) as OpenAI.ChatCompletion;

      summaryContent =
        response.choices[0]?.message?.content?.trim() ??
        `[Compressed: ${oldMessages.length} messages]`;
    } else {
      summaryContent = `[Compressed: ${oldMessages.length} older messages, ~${oldMessages.reduce((s, m) => s + Math.ceil(m.content.length / 4), 0)} tokens]`;
    }

    const summaryMessage: ConversationMessage = {
      role: 'system',
      content: `[Previous conversation summary]: ${summaryContent}`,
      timestamp: new Date(),
    };

    this.histories.set(agentId, [systemMessage, summaryMessage, ...recentMessages]);
  }

  clear(agentId: string): void {
    this.histories.delete(agentId);
    this.persistence?.clearConversationMessages(agentId);
  }

  /** Restore conversation history from persistence layer */
  restore(agentId: string): void {
    if (!this.persistence) return;
    const messages = this.persistence.getConversationMessages(agentId);
    this.histories.set(
      agentId,
      messages.map((m) => ({
        role: m.role,
        content: m.content,
        timestamp: new Date(m.timestamp),
      })),
    );
  }
}
