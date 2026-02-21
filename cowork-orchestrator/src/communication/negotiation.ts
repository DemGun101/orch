import type { Task } from '../core/types.js';
import type { MessageBus } from './message-bus.js';
import { createMessage, createDelegation, CHANNELS } from './protocols.js';

// ─── Negotiation Manager ────────────────────────────────────────────

export class NegotiationManager {
  constructor(private messageBus: MessageBus) {}

  /**
   * Request delegation of a task from one agent to another.
   * Returns true if the target agent accepts.
   */
  async requestDelegation(
    fromAgentId: string,
    toAgentId: string,
    task: Task,
    reason: string,
  ): Promise<boolean> {
    const message = createDelegation(fromAgentId, toAgentId, task, reason);
    try {
      const response = await this.messageBus.request(message, 30000);
      const payload = response.payload as { accepted: boolean };
      return payload.accepted;
    } catch {
      return false;
    }
  }

  /**
   * Propose splitting a task into subtasks.
   * Broadcasts the proposal; returns the proposed split (enhanced with AI in Phase 2).
   */
  async proposeTaskSplit(
    agentId: string,
    task: Task,
    proposedSplit: Task[],
  ): Promise<Task[]> {
    const message = createMessage(
      agentId,
      '*',
      'negotiation',
      CHANNELS.NEGOTIATION,
      { type: 'task-split-proposal', taskId: task.id, proposedSplit },
    );
    this.messageBus.publish(message);
    return proposedSplit;
  }

  /**
   * Resolve contention when multiple agents could handle a task.
   * Queries each candidate for availability and picks the best scorer.
   */
  async resolveContention(
    taskId: string,
    candidateAgentIds: string[],
  ): Promise<string> {
    if (candidateAgentIds.length === 0) {
      throw new Error('No candidate agents provided for contention resolution');
    }
    if (candidateAgentIds.length === 1) {
      return candidateAgentIds[0];
    }

    const scores = new Map<string, number>();

    const checks = candidateAgentIds.map(async (agentId) => {
      const request = createMessage(
        'orchestrator',
        agentId,
        'request',
        CHANNELS.STATUS,
        { type: 'availability-check', taskId },
      );
      try {
        const response = await this.messageBus.request(request, 5000);
        const payload = response.payload as {
          available: boolean;
          load: number;
        };
        scores.set(agentId, payload.available ? 100 - (payload.load ?? 50) : 0);
      } catch {
        scores.set(agentId, 1);
      }
    });

    await Promise.allSettled(checks);

    let bestAgent = candidateAgentIds[0];
    let bestScore = scores.get(bestAgent) ?? 0;

    for (const agentId of candidateAgentIds) {
      const score = scores.get(agentId) ?? 0;
      if (score > bestScore) {
        bestScore = score;
        bestAgent = agentId;
      }
    }

    return bestAgent;
  }
}
