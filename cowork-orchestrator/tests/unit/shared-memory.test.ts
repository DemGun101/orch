import { describe, it, expect, vi } from 'vitest';
import { SharedMemoryStore } from '../../src/memory/shared-memory.js';

describe('SharedMemoryStore', () => {
  // ─── Basic CRUD ─────────────────────────────────────────────────

  describe('set/get/delete', () => {
    it('stores and retrieves values with namespace', async () => {
      const store = new SharedMemoryStore();
      await store.set('ns1', 'key1', 'value1');

      expect(store.get('ns1', 'key1')).toBe('value1');
    });

    it('returns undefined for missing keys', () => {
      const store = new SharedMemoryStore();
      expect(store.get('ns1', 'missing')).toBeUndefined();
    });

    it('deletes existing key', async () => {
      const store = new SharedMemoryStore();
      await store.set('ns1', 'key1', 'value1');

      expect(store.delete('ns1', 'key1')).toBe(true);
      expect(store.get('ns1', 'key1')).toBeUndefined();
    });

    it('delete returns false for missing key', () => {
      const store = new SharedMemoryStore();
      expect(store.delete('ns1', 'missing')).toBe(false);
    });

    it('namespaces isolate keys', async () => {
      const store = new SharedMemoryStore();
      await store.set('ns1', 'key', 'value-from-ns1');
      await store.set('ns2', 'key', 'value-from-ns2');

      expect(store.get('ns1', 'key')).toBe('value-from-ns1');
      expect(store.get('ns2', 'key')).toBe('value-from-ns2');
    });

    it('handles complex values', async () => {
      const store = new SharedMemoryStore();
      const complexValue = { nested: { array: [1, 2, 3], flag: true } };
      await store.set('ns1', 'complex', complexValue);

      expect(store.get('ns1', 'complex')).toEqual(complexValue);
    });
  });

  // ─── getNamespace ───────────────────────────────────────────────

  describe('getNamespace', () => {
    it('returns all keys in a namespace', async () => {
      const store = new SharedMemoryStore();
      await store.set('ns1', 'a', 1);
      await store.set('ns1', 'b', 2);
      await store.set('ns2', 'c', 3);

      const ns1 = store.getNamespace('ns1');
      expect(ns1).toEqual({ a: 1, b: 2 });
    });

    it('returns empty object for empty namespace', () => {
      const store = new SharedMemoryStore();
      expect(store.getNamespace('empty')).toEqual({});
    });
  });

  // ─── Subscriptions ─────────────────────────────────────────────

  describe('subscribe', () => {
    it('fires callback on matching key changes', async () => {
      const store = new SharedMemoryStore();
      const callback = vi.fn();

      store.subscribe('ns1:*', callback);
      await store.set('ns1', 'key1', 'value1');

      expect(callback).toHaveBeenCalledWith('ns1:key1', 'value1');
    });

    it('does NOT fire on non-matching changes', async () => {
      const store = new SharedMemoryStore();
      const callback = vi.fn();

      store.subscribe('ns1:*', callback);
      await store.set('ns2', 'key1', 'value1');

      expect(callback).not.toHaveBeenCalled();
    });

    it('unsubscribe stops notifications', async () => {
      const store = new SharedMemoryStore();
      const callback = vi.fn();

      const unsub = store.subscribe('ns1:*', callback);
      unsub();
      await store.set('ns1', 'key1', 'value1');

      expect(callback).not.toHaveBeenCalled();
    });
  });

  // ─── Event Listeners ───────────────────────────────────────────

  describe('onChange/onDelete', () => {
    it('onChange fires on set', async () => {
      const store = new SharedMemoryStore();
      const handler = vi.fn();

      store.onChange(handler);
      await store.set('ns1', 'k', 'v');

      expect(handler).toHaveBeenCalledWith('ns1:k', 'v');
    });

    it('onDelete fires on delete', async () => {
      const store = new SharedMemoryStore();
      const handler = vi.fn();

      await store.set('ns1', 'k', 'v');
      store.onDelete(handler);
      store.delete('ns1', 'k');

      expect(handler).toHaveBeenCalledWith('ns1:k');
    });
  });
});
