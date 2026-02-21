import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  RateLimiter,
  APIRateLimiter,
  ConcurrencyLimiter,
} from '../../src/resilience/rate-limiter.js';

// ─── RateLimiter ───────────────────────────────────────────────────

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('acquire succeeds when tokens available', async () => {
    const limiter = new RateLimiter({ maxTokens: 5, refillRate: 1 });

    // Should resolve immediately without waiting
    await limiter.acquire(1);

    expect(limiter.getAvailable()).toBe(4);
  });

  it('tryAcquire returns true when tokens available and consumes tokens', () => {
    const limiter = new RateLimiter({ maxTokens: 5, refillRate: 1 });

    const result = limiter.tryAcquire(2);

    expect(result).toBe(true);
    expect(limiter.getAvailable()).toBe(3);
  });

  it('tryAcquire returns false when no tokens available', () => {
    const limiter = new RateLimiter({ maxTokens: 2, refillRate: 1 });

    limiter.tryAcquire(2); // consume all tokens
    const result = limiter.tryAcquire(1);

    expect(result).toBe(false);
  });

  it('getAvailable returns current token count', () => {
    const limiter = new RateLimiter({ maxTokens: 10, refillRate: 1 });

    expect(limiter.getAvailable()).toBe(10);

    limiter.tryAcquire(3);
    expect(limiter.getAvailable()).toBe(7);
  });
});

// ─── ConcurrencyLimiter ────────────────────────────────────────────

describe('ConcurrencyLimiter', () => {
  it('allows up to maxConcurrent simultaneous calls', async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrent: 2 });

    const release1 = await limiter.acquire();
    const release2 = await limiter.acquire();

    expect(limiter.getActive()).toBe(2);

    release1();
    release2();
  });

  it('queues when at max and dequeues on release', async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrent: 1 });

    const release1 = await limiter.acquire();
    expect(limiter.getActive()).toBe(1);

    // This acquire will be queued since we are at max
    let release2: (() => void) | undefined;
    const pending = limiter.acquire().then((r) => {
      release2 = r;
    });

    // The second acquire should be waiting
    expect(limiter.getWaiting()).toBe(1);

    // Releasing the first should dequeue the second
    release1();
    await pending;

    expect(release2).toBeDefined();
    expect(limiter.getActive()).toBe(1);
    expect(limiter.getWaiting()).toBe(0);

    release2!();
  });

  it('getActive and getWaiting return correct counts', async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrent: 1 });

    expect(limiter.getActive()).toBe(0);
    expect(limiter.getWaiting()).toBe(0);

    const release1 = await limiter.acquire();
    expect(limiter.getActive()).toBe(1);
    expect(limiter.getWaiting()).toBe(0);

    // Queue two more
    const pending2 = limiter.acquire();
    const pending3 = limiter.acquire();

    expect(limiter.getActive()).toBe(1);
    expect(limiter.getWaiting()).toBe(2);

    // Release first, second should become active
    release1();
    const release2 = await pending2;

    expect(limiter.getActive()).toBe(1);
    expect(limiter.getWaiting()).toBe(1);

    release2();
    const release3 = await pending3;

    expect(limiter.getActive()).toBe(1);
    expect(limiter.getWaiting()).toBe(0);

    release3();

    expect(limiter.getActive()).toBe(0);
    expect(limiter.getWaiting()).toBe(0);
  });
});

// ─── APIRateLimiter ────────────────────────────────────────────────

describe('APIRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('acquireRequest consumes from request bucket', async () => {
    const limiter = new APIRateLimiter({
      requestsPerMinute: 60,
      tokensPerMinute: 10000,
    });

    await limiter.acquireRequest();

    const stats = limiter.getStats();
    expect(stats.requestsUsed).toBe(1);
    // Started with 60 tokens, consumed 1
    expect(stats.requestsAvailable).toBe(59);
  });

  it('getStats returns usage info', async () => {
    const limiter = new APIRateLimiter({
      requestsPerMinute: 60,
      tokensPerMinute: 10000,
    });

    const stats = limiter.getStats();

    expect(stats).toEqual({
      requestsAvailable: 60,
      tokensAvailable: 10000,
      requestsUsed: 0,
      tokensUsed: 0,
    });
  });

  it('recordUsage tracks tokens', async () => {
    const limiter = new APIRateLimiter({
      requestsPerMinute: 60,
      tokensPerMinute: 10000,
    });

    limiter.recordUsage(100, 200);
    limiter.recordUsage(50, 75);

    const stats = limiter.getStats();
    expect(stats.tokensUsed).toBe(425); // 100+200+50+75
  });
});
