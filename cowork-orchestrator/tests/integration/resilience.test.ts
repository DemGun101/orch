import { describe, it, expect, vi } from 'vitest';
import {
  ExponentialBackoff,
  CircuitBreaker,
  CircuitOpenError,
  withRetry,
} from '../../src/resilience/retry-strategies.js';
import { RateLimiter, ConcurrencyLimiter } from '../../src/resilience/rate-limiter.js';
import {
  ErrorHandler,
  TaskExecutionError,
  APIError,
  TimeoutError,
} from '../../src/resilience/error-handler.js';

// ─── Retry with Transient Errors ─────────────────────────────────────

describe('resilience integration', () => {
  it('retry on transient error', async () => {
    const backoff = new ExponentialBackoff({
      jitter: false,
      maxAttempts: 5,
      baseDelay: 0,
    });

    let callCount = 0;
    const fn = vi.fn(async () => {
      callCount++;
      if (callCount <= 2) {
        const err = new Error('rate limited') as Error & { status: number };
        err.status = 429;
        throw err;
      }
      return 'success';
    });

    const result = await withRetry(fn, backoff, 5);

    expect(fn).toHaveBeenCalledTimes(3);
    expect(result).toBe('success');
  });

  // ─── Circuit Breaker Opens After Failures ────────────────────────────

  it('circuit breaker opens after failures', async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 3,
      recoveryTimeout: 100,
      successThreshold: 1,
    });

    const failingFn = vi.fn(async () => {
      throw new Error('service down');
    });

    // Trigger 3 failures to trip the breaker
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(failingFn)).rejects.toThrow('service down');
    }

    expect(failingFn).toHaveBeenCalledTimes(3);
    expect(breaker.getState()).toBe('OPEN');

    // 4th call should throw CircuitOpenError without invoking fn
    await expect(breaker.execute(failingFn)).rejects.toThrow(CircuitOpenError);
    expect(failingFn).toHaveBeenCalledTimes(3); // still 3 — fn was never called
  });

  // ─── Circuit Breaker Recovers After Timeout ──────────────────────────

  it('circuit breaker recovers after timeout', async () => {
    vi.useFakeTimers();

    try {
      const breaker = new CircuitBreaker({
        failureThreshold: 3,
        recoveryTimeout: 100,
        successThreshold: 1,
      });

      const failingFn = async () => {
        throw new Error('service down');
      };

      // Trip the breaker with 3 failures
      for (let i = 0; i < 3; i++) {
        await expect(breaker.execute(failingFn)).rejects.toThrow('service down');
      }
      expect(breaker.getState()).toBe('OPEN');

      // Advance past recoveryTimeout
      vi.advanceTimersByTime(101);

      // State should now be HALF_OPEN (checked lazily on getState)
      expect(breaker.getState()).toBe('HALF_OPEN');

      // A successful call should transition back to CLOSED
      const successFn = vi.fn(async () => 'ok');
      const result = await breaker.execute(successFn);

      expect(result).toBe('ok');
      expect(successFn).toHaveBeenCalledTimes(1);
      expect(breaker.getState()).toBe('CLOSED');
    } finally {
      vi.useRealTimers();
    }
  });

  // ─── Concurrency Limiter Enforces Max Concurrent ─────────────────────

  it('concurrency limiter enforces max concurrent', async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrent: 2 });

    // Acquire 2 slots — should succeed immediately
    const release1 = await limiter.acquire();
    const release2 = await limiter.acquire();

    expect(limiter.getActive()).toBe(2);
    expect(limiter.getWaiting()).toBe(0);

    // 3rd acquire should be queued
    let thirdResolved = false;
    const thirdPromise = limiter.acquire().then((release) => {
      thirdResolved = true;
      return release;
    });

    // Flush microtasks
    await new Promise((r) => setTimeout(r, 0));
    expect(limiter.getWaiting()).toBe(1);
    expect(thirdResolved).toBe(false);

    // Release one slot — queued request should proceed
    release1();
    await new Promise((r) => setTimeout(r, 0));

    expect(thirdResolved).toBe(true);
    expect(limiter.getActive()).toBe(2);
    expect(limiter.getWaiting()).toBe(0);

    // Clean up
    const release3 = await thirdPromise;
    release2();
    release3();

    expect(limiter.getActive()).toBe(0);
  });

  // ─── Error Handler Decides Recovery Action ───────────────────────────

  it('error handler decides recovery action flow', async () => {
    const handler = new ErrorHandler({ maxRetries: 2 });

    // APIError(429) with retryCount=0 → RETRY
    const apiErr1 = new APIError('rate limited', 429, { retryCount: 0 });
    const action1 = await handler.handleError(apiErr1);
    expect(action1).toBe('RETRY');

    // APIError(429) with retryCount=2 (at maxRetries) → ESCALATE
    const apiErr2 = new APIError('rate limited', 429, { retryCount: 2 });
    const action2 = await handler.handleError(apiErr2);
    expect(action2).toBe('ESCALATE');

    // TaskExecutionError with retryCount=2 (at maxRetries) → REASSIGN
    const taskErr = new TaskExecutionError('task failed', { retryCount: 2 });
    const action3 = await handler.handleError(taskErr);
    expect(action3).toBe('REASSIGN');
  });
});
