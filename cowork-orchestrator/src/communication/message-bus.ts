import { EventEmitter } from 'eventemitter3';
import type { AgentMessage } from '../core/types.js';
import type { PersistenceLayer } from '../memory/persistence.js';

// ─── Types ──────────────────────────────────────────────────────────

type MessageHandler = (message: AgentMessage) => void;

export interface BusMetrics {
  messagesSent: number;
  messagesDelivered: number;
  messagesFailed: number;
  avgDeliveryTimeMs: number;
  deadLetterCount: number;
}

export interface MessageBusOptions {
  maxHistoryPerChannel?: number;
  persistence?: PersistenceLayer;
}

// ─── Message Bus ────────────────────────────────────────────────────

export class MessageBus {
  private emitter = new EventEmitter();
  private subscriptions = new Map<string, Map<string, MessageHandler>>();
  private history = new Map<string, AgentMessage[]>();
  private deadLetterQueue: AgentMessage[] = [];
  private maxHistoryPerChannel: number;
  private persistence?: PersistenceLayer;
  private totalDeliveryTime = 0;
  private metrics: BusMetrics = {
    messagesSent: 0,
    messagesDelivered: 0,
    messagesFailed: 0,
    avgDeliveryTimeMs: 0,
    deadLetterCount: 0,
  };

  constructor(options?: MessageBusOptions) {
    this.maxHistoryPerChannel = options?.maxHistoryPerChannel ?? 100;
    this.persistence = options?.persistence;
  }

  subscribe(agentId: string, channel: string, handler: MessageHandler): void {
    if (!this.subscriptions.has(channel)) {
      this.subscriptions.set(channel, new Map());
    }
    this.subscriptions.get(channel)!.set(agentId, handler);
  }

  unsubscribe(agentId: string, channel: string): void {
    this.subscriptions.get(channel)?.delete(agentId);
  }

  publish(message: AgentMessage): void {
    const startTime = Date.now();
    this.metrics.messagesSent++;

    this.addToHistory(message);
    this.persistence?.saveMessage(message);

    const channelSubs = this.subscriptions.get(message.channel);
    let delivered = false;

    if (channelSubs && channelSubs.size > 0) {
      if (message.to === '*') {
        for (const [, handler] of channelSubs) {
          try {
            handler(message);
            delivered = true;
            this.metrics.messagesDelivered++;
          } catch {
            this.metrics.messagesFailed++;
          }
        }
      } else {
        const handler = channelSubs.get(message.to);
        if (handler) {
          try {
            handler(message);
            delivered = true;
            this.metrics.messagesDelivered++;
          } catch {
            this.metrics.messagesFailed++;
          }
        }
      }
    }

    if (!delivered) {
      this.deadLetterQueue.push(message);
      this.metrics.messagesFailed++;
      this.metrics.deadLetterCount++;
    }

    const deliveryTime = Date.now() - startTime;
    this.totalDeliveryTime += deliveryTime;
    this.metrics.avgDeliveryTimeMs =
      this.totalDeliveryTime / (this.metrics.messagesDelivered || 1);

    // Emit for request/response correlation
    this.emitter.emit(`response:${message.to}`, message);
  }

  async request(
    message: AgentMessage,
    timeout: number = 30000,
  ): Promise<AgentMessage> {
    return new Promise<AgentMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.emitter.off(`response:${message.from}`, handler);
        reject(new Error(`Request timed out after ${timeout}ms`));
      }, timeout);

      const handler = (response: AgentMessage) => {
        if (
          response.correlationId === message.id &&
          response.type === 'response'
        ) {
          clearTimeout(timer);
          this.emitter.off(`response:${message.from}`, handler);
          resolve(response);
        }
      };

      this.emitter.on(`response:${message.from}`, handler);
      this.publish(message);
    });
  }

  getMetrics(): BusMetrics {
    return { ...this.metrics };
  }

  getDeadLetterQueue(): AgentMessage[] {
    return [...this.deadLetterQueue];
  }

  getChannelHistory(channel: string): AgentMessage[] {
    return [...(this.history.get(channel) ?? [])];
  }

  private addToHistory(message: AgentMessage): void {
    if (!this.history.has(message.channel)) {
      this.history.set(message.channel, []);
    }
    const channelHistory = this.history.get(message.channel)!;
    channelHistory.push(message);
    if (channelHistory.length > this.maxHistoryPerChannel) {
      channelHistory.shift();
    }
  }
}
