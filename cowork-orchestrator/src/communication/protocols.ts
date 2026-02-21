import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import type { AgentMessage, Task } from '../core/types.js';

// ─── Channel Constants ──────────────────────────────────────────────

export const CHANNELS = {
  TASK: 'task',
  STATUS: 'status',
  NEGOTIATION: 'negotiation',
  SYSTEM: 'system',
  DATA: 'data',
} as const;

// ─── Message Validation Schema ──────────────────────────────────────

const AgentMessageSchema = z.object({
  id: z.string(),
  from: z.string().min(1),
  to: z.union([z.string().min(1), z.literal('*')]),
  type: z.enum(['request', 'response', 'event', 'delegation', 'negotiation']),
  channel: z.string().min(1),
  payload: z.unknown(),
  timestamp: z.date(),
  correlationId: z.string().optional(),
});

// ─── Factory Functions ──────────────────────────────────────────────

export function createMessage(
  from: string,
  to: string | '*',
  type: AgentMessage['type'],
  channel: string,
  payload: unknown,
): AgentMessage {
  return {
    id: uuidv4(),
    from,
    to,
    type,
    channel,
    payload,
    timestamp: new Date(),
  };
}

export function createRequest(
  from: string,
  to: string,
  channel: string,
  payload: unknown,
): AgentMessage {
  return createMessage(from, to, 'request', channel, payload);
}

export function createResponse(
  originalMessage: AgentMessage,
  payload: unknown,
): AgentMessage {
  return {
    id: uuidv4(),
    from: originalMessage.to as string,
    to: originalMessage.from,
    type: 'response',
    channel: originalMessage.channel,
    payload,
    timestamp: new Date(),
    correlationId: originalMessage.id,
  };
}

export function createBroadcast(
  from: string,
  channel: string,
  payload: unknown,
): AgentMessage {
  return createMessage(from, '*', 'event', channel, payload);
}

export function createDelegation(
  from: string,
  to: string,
  task: Task,
  reason: string,
): AgentMessage {
  return createMessage(from, to, 'delegation', CHANNELS.TASK, { task, reason });
}

// ─── Validation ─────────────────────────────────────────────────────

export function validateMessage(msg: unknown): boolean {
  return AgentMessageSchema.safeParse(msg).success;
}
