import { EventEmitter } from 'eventemitter3';
import type { PersistenceLayer } from './persistence.js';

// ─── Async Lock ─────────────────────────────────────────────────────

class AsyncLock {
  private queue: Array<() => void> = [];
  private locked = false;

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}

// ─── Glob Pattern Matching ──────────────────────────────────────────

function matchGlob(pattern: string, str: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`).test(str);
}

// ─── Types ──────────────────────────────────────────────────────────

type ChangeCallback = (key: string, value: unknown) => void;

interface SharedMemoryEvents {
  change: (key: string, value: unknown) => void;
  delete: (key: string) => void;
}

// ─── Shared Memory Store ────────────────────────────────────────────

export class SharedMemoryStore {
  private store = new Map<string, unknown>();
  private emitter = new EventEmitter<SharedMemoryEvents>();
  private lock = new AsyncLock();
  private subscriptions = new Map<string, Set<ChangeCallback>>();
  private persistence?: PersistenceLayer;

  constructor(persistence?: PersistenceLayer) {
    this.persistence = persistence;
  }

  async set(namespace: string, key: string, value: unknown): Promise<void> {
    await this.lock.acquire();
    try {
      const compositeKey = `${namespace}:${key}`;
      this.store.set(compositeKey, value);
      this.persistence?.setSharedValue(compositeKey, value);
      this.emitter.emit('change', compositeKey, value);
      this.notifySubscribers(compositeKey, value);
    } finally {
      this.lock.release();
    }
  }

  get<T>(namespace: string, key: string): T | undefined {
    return this.store.get(`${namespace}:${key}`) as T | undefined;
  }

  delete(namespace: string, key: string): boolean {
    const compositeKey = `${namespace}:${key}`;
    const existed = this.store.delete(compositeKey);
    if (existed) {
      this.persistence?.deleteSharedValue(compositeKey);
      this.emitter.emit('delete', compositeKey);
    }
    return existed;
  }

  getNamespace(namespace: string): Record<string, unknown> {
    const prefix = `${namespace}:`;
    const result: Record<string, unknown> = {};
    for (const [key, value] of this.store) {
      if (key.startsWith(prefix)) {
        result[key.slice(prefix.length)] = value;
      }
    }
    return result;
  }

  subscribe(pattern: string, callback: ChangeCallback): () => void {
    if (!this.subscriptions.has(pattern)) {
      this.subscriptions.set(pattern, new Set());
    }
    this.subscriptions.get(pattern)!.add(callback);
    return () => {
      this.subscriptions.get(pattern)?.delete(callback);
    };
  }

  onChange(handler: (key: string, value: unknown) => void): () => void {
    this.emitter.on('change', handler);
    return () => this.emitter.off('change', handler);
  }

  onDelete(handler: (key: string) => void): () => void {
    this.emitter.on('delete', handler);
    return () => this.emitter.off('delete', handler);
  }

  /** Load all persisted values into memory */
  restore(): void {
    if (!this.persistence) return;
    const entries = this.persistence.listSharedValues('');
    for (const entry of entries) {
      this.store.set(entry.key, entry.value);
    }
  }

  private notifySubscribers(key: string, value: unknown): void {
    for (const [pattern, callbacks] of this.subscriptions) {
      if (matchGlob(pattern, key)) {
        for (const cb of callbacks) {
          cb(key, value);
        }
      }
    }
  }
}
