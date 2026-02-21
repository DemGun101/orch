import { describe, it, expect, vi } from 'vitest';
import { MessageBus } from '../../src/communication/message-bus.js';
import type { AgentMessage } from '../../src/core/types.js';
import { v4 as uuidv4 } from 'uuid';

function createMessage(overrides?: Partial<AgentMessage>): AgentMessage {
  return {
    id: uuidv4(),
    from: 'agent-sender',
    to: 'agent-receiver',
    type: 'request',
    channel: 'test-channel',
    payload: { data: 'hello' },
    timestamp: new Date(),
    ...overrides,
  };
}

describe('MessageBus', () => {
  // ─── Publish / Subscribe ────────────────────────────────────────

  describe('subscribe + publish', () => {
    it('delivers message to correct agent', () => {
      const bus = new MessageBus();
      const handler = vi.fn();

      bus.subscribe('agent-receiver', 'test-channel', handler);
      bus.publish(createMessage());

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].payload).toEqual({ data: 'hello' });
    });

    it('does not deliver to wrong agent', () => {
      const bus = new MessageBus();
      const handler = vi.fn();

      bus.subscribe('other-agent', 'test-channel', handler);
      bus.publish(createMessage({ to: 'agent-receiver' }));

      expect(handler).not.toHaveBeenCalled();
    });

    it('does not deliver to wrong channel', () => {
      const bus = new MessageBus();
      const handler = vi.fn();

      bus.subscribe('agent-receiver', 'other-channel', handler);
      bus.publish(createMessage());

      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ─── Broadcast ──────────────────────────────────────────────────

  describe('broadcast', () => {
    it('delivers to all subscribers on channel when to="*"', () => {
      const bus = new MessageBus();
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      bus.subscribe('agent-1', 'broadcast-channel', handler1);
      bus.subscribe('agent-2', 'broadcast-channel', handler2);

      bus.publish(createMessage({ to: '*', channel: 'broadcast-channel' }));

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Request / Response ─────────────────────────────────────────

  describe('request/response', () => {
    it('resolves when correlated response arrives', async () => {
      const bus = new MessageBus();
      const requestMsg = createMessage({ from: 'requester', to: 'responder' });

      // Set up responder that replies
      bus.subscribe('responder', 'test-channel', (msg) => {
        bus.publish({
          id: uuidv4(),
          from: 'responder',
          to: 'requester',
          type: 'response',
          channel: 'test-channel',
          payload: { answer: 42 },
          timestamp: new Date(),
          correlationId: msg.id,
        });
      });

      const response = await bus.request(requestMsg, 5000);
      expect(response.type).toBe('response');
      expect(response.payload).toEqual({ answer: 42 });
    });

    it('rejects on timeout', async () => {
      const bus = new MessageBus();
      const requestMsg = createMessage();

      // Nobody responds
      await expect(bus.request(requestMsg, 50)).rejects.toThrow('timed out');
    });
  });

  // ─── Dead Letter Queue ──────────────────────────────────────────

  describe('dead letter queue', () => {
    it('undeliverable messages go to dead letter queue', () => {
      const bus = new MessageBus();
      // No subscribers — message is undeliverable
      bus.publish(createMessage());

      const dlq = bus.getDeadLetterQueue();
      expect(dlq.length).toBe(1);
    });
  });

  // ─── Metrics ────────────────────────────────────────────────────

  describe('getMetrics', () => {
    it('tracks message counts correctly', () => {
      const bus = new MessageBus();
      const handler = vi.fn();

      bus.subscribe('agent-receiver', 'test-channel', handler);
      bus.publish(createMessage());
      bus.publish(createMessage({ to: 'nobody' })); // dead letter

      const metrics = bus.getMetrics();
      expect(metrics.messagesSent).toBe(2);
      expect(metrics.messagesDelivered).toBe(1);
      expect(metrics.deadLetterCount).toBe(1);
    });
  });

  // ─── Channel History ────────────────────────────────────────────

  describe('channel history', () => {
    it('stores messages in channel history', () => {
      const bus = new MessageBus();
      bus.publish(createMessage({ channel: 'ch1' }));
      bus.publish(createMessage({ channel: 'ch1' }));
      bus.publish(createMessage({ channel: 'ch2' }));

      expect(bus.getChannelHistory('ch1').length).toBe(2);
      expect(bus.getChannelHistory('ch2').length).toBe(1);
    });
  });

  // ─── Unsubscribe ────────────────────────────────────────────────

  describe('unsubscribe', () => {
    it('stops delivering after unsubscribe', () => {
      const bus = new MessageBus();
      const handler = vi.fn();

      bus.subscribe('agent-receiver', 'test-channel', handler);
      bus.unsubscribe('agent-receiver', 'test-channel');
      bus.publish(createMessage());

      expect(handler).not.toHaveBeenCalled();
    });
  });
});
