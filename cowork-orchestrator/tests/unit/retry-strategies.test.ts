import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  ExponentialBackoff,
  CircuitBreaker,
  CircuitOpenError,
  withRetry,
} from '../../src/resilience/retry-strategies.js';
import type { RetryStrategy } from '../../src/resilience/retry-strategies.js';

// ─── ExponentialBackoff ──────────────────────────────────────────────

describe('ExponentialBackoff', () => {
  describe('getDelay', () => {
    it('calculates exponential delays: attempt 0=1s, 1=2s, 2=4s, 3=8s', () => {
      const backoff = new ExponentialBackoff({ jitter: false });

      expect(backoff.getDelay(0)).toBe(1000);
      expect(backoff.getDelay(1)).toBe(2000);
      expect(backoff.getDelay(2)).toBe(4000);
      expect(backoff.getDelay(3)).toBe(8000);
    });

    it('caps delay at maxDelay', () => {
      const backoff = new ExponentialBackoff({
        baseDelay: 1000,
        factor: 2,
        maxDelay: 5000,
        jitter: false,
      });

      // attempt 2 = 1000 * 2^2 = 4000 (under cap)
      expect(backoff.getDelay(2)).toBe(4000);
      // attempt 3 = 1000 * 2^3 = 8000 → capped to 5000
      expect(backoff.getDelay(3)).toBe(5000);
      // attempt 10 = way over → capped to 5000
      expect(backoff.getDelay(10)).toBe(5000);
    });

    it('adds jitter within 0-30% of base delay when jitter is enabled', () => {
      const backoff = new ExponentialBackoff({
        baseDelay: 1000,
        factor: 2,
        jitter: true,
      });

      // Run multiple times to verify the range
      for (let i = 0; i < 50; i++) {
        const delay = backoff.getDelay(0);
        // base = 1000, jitter adds 0..300 → range [1000, 1300]
        expect(delay).toBeGreaterThanOrEqual(1000);
        expect(delay).toBeLessThanOrEqual(1300);
      }
    });
  });

  describe('shouldRetry', () => {
    it('returns false when attempt >= maxAttempts', () => {
      const backoff = new ExponentialBackoff({ maxAttempts: 3 });

      expect(backoff.shouldRetry(new Error('fail'), 3)).toBe(false);
      expect(backoff.shouldRetry(new Error('fail'), 4)).toBe(false);
    });

    it('returns true for error with status 429', () => {
      const backoff = new ExponentialBackoff({ maxAttempts: 3 });
      const error = Object.assign(new Error('rate limited'), { status: 429 });

      expect(backoff.shouldRetry(error, 0)).toBe(true);
    });

    it('returns true for error with status 500', () => {
      const backoff = new ExponentialBackoff({ maxAttempts: 3 });
      const error = Object.assign(new Error('server error'), { status: 500 });

      expect(backoff.shouldRetry(error, 0)).toBe(true);
    });

    it('returns true for error with status 503', () => {
      const backoff = new ExponentialBackoff({ maxAttempts: 3 });
      const error = Object.assign(new Error('service unavailable'), { status: 503 });

      expect(backoff.shouldRetry(error, 0)).toBe(true);
    });

    it('returns true for any error when no retryableErrors filter is set', () => {
      const backoff = new ExponentialBackoff({ maxAttempts: 3 });

      expect(backoff.shouldRetry(new Error('random error'), 0)).toBe(true);
    });

    it('returns true when error matches retryableErrors pattern', () => {
      const backoff = new ExponentialBackoff({
        maxAttempts: 3,
        retryableErrors: ['timeout', 'ECONNRESET'],
      });

      expect(backoff.shouldRetry(new Error('connection timeout'), 0)).toBe(true);
      expect(backoff.shouldRetry(new Error('ECONNRESET'), 0)).toBe(true);
    });

    it('returns false when error does not match retryableErrors pattern', () => {
      const backoff = new ExponentialBackoff({
        maxAttempts: 3,
        retryableErrors: ['timeout'],
      });

      expect(backoff.shouldRetry(new Error('validation failed'), 0)).toBe(false);
    });
  });
});

// ─── CircuitBreaker ──────────────────────────────────────────────────

describe('CircuitBreaker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('executes function normally in CLOSED state', async () => {
    const breaker = new CircuitBreaker();

    const result = await breaker.execute(async () => 'success');

    expect(result).toBe('success');
    expect(breaker.getState()).toBe('CLOSED');
  });

  it('transitions from CLOSED to OPEN after failureThreshold failures', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3 });

    const failFn = async () => {
      throw new Error('fail');
    };

    // Trip the breaker with 3 failures
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(failFn)).rejects.toThrow('fail');
    }

    expect(breaker.getState()).toBe('OPEN');

    // Next call should throw CircuitOpenError
    await expect(breaker.execute(async () => 'ok')).rejects.toThrow(CircuitOpenError);
  });

  it('transitions from OPEN to HALF_OPEN after recoveryTimeout', async () => {
    vi.useFakeTimers();
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      recoveryTimeout: 5000,
    });

    const failFn = async () => {
      throw new Error('fail');
    };

    // Trip to OPEN
    for (let i = 0; i < 2; i++) {
      await expect(breaker.execute(failFn)).rejects.toThrow('fail');
    }
    expect(breaker.getState()).toBe('OPEN');

    // Advance past the recovery timeout
    vi.advanceTimersByTime(5001);

    // After recovery timeout, getState() should return HALF_OPEN
    expect(breaker.getState()).toBe('HALF_OPEN');
  });

  it('transitions from HALF_OPEN to CLOSED after successThreshold successes', async () => {
    vi.useFakeTimers();
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      recoveryTimeout: 5000,
      successThreshold: 2,
    });

    const failFn = async () => {
      throw new Error('fail');
    };

    // Trip to OPEN
    for (let i = 0; i < 2; i++) {
      await expect(breaker.execute(failFn)).rejects.toThrow('fail');
    }
    expect(breaker.getState()).toBe('OPEN');

    // Advance past recovery timeout → HALF_OPEN
    vi.advanceTimersByTime(5001);

    // Two successes should close the circuit
    await breaker.execute(async () => 'ok');
    expect(breaker.getState()).toBe('HALF_OPEN');

    await breaker.execute(async () => 'ok');
    expect(breaker.getState()).toBe('CLOSED');
  });

  it('transitions from HALF_OPEN to OPEN on any failure', async () => {
    vi.useFakeTimers();
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      recoveryTimeout: 5000,
      successThreshold: 3,
    });

    const failFn = async () => {
      throw new Error('fail');
    };

    // Trip to OPEN
    for (let i = 0; i < 2; i++) {
      await expect(breaker.execute(failFn)).rejects.toThrow('fail');
    }
    expect(breaker.getState()).toBe('OPEN');

    // Advance past recovery timeout → HALF_OPEN
    vi.advanceTimersByTime(5001);
    expect(breaker.getState()).toBe('HALF_OPEN');

    // A single failure in HALF_OPEN should go back to OPEN
    await expect(breaker.execute(failFn)).rejects.toThrow('fail');
    expect(breaker.getState()).toBe('OPEN');
  });

  it('reset() forces the circuit back to CLOSED', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2 });

    const failFn = async () => {
      throw new Error('fail');
    };

    // Trip to OPEN
    for (let i = 0; i < 2; i++) {
      await expect(breaker.execute(failFn)).rejects.toThrow('fail');
    }
    expect(breaker.getState()).toBe('OPEN');

    breaker.reset();
    expect(breaker.getState()).toBe('CLOSED');

    // Should work normally again
    const result = await breaker.execute(async () => 'recovered');
    expect(result).toBe('recovered');
  });
});

// ─── withRetry ───────────────────────────────────────────────────────

describe('withRetry', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('succeeds on 3rd attempt after 2 failures', async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      if (callCount < 3) {
        throw new Error(`failure ${callCount}`);
      }
      return 'success';
    };

    // Use a zero-delay strategy to avoid timer complications
    const strategy: RetryStrategy = {
      shouldRetry: () => true,
      getDelay: () => 0,
    };

    const result = await withRetry(fn, strategy, 3);

    expect(result).toBe('success');
    expect(callCount).toBe(3);
  });

  it('throws the last error when all attempts are exhausted', async () => {
    const strategy: RetryStrategy = {
      shouldRetry: () => true,
      getDelay: () => 0,
    };

    const fn = async () => {
      throw new Error('persistent failure');
    };

    // withRetry throws on the last attempt without consulting shouldRetry
    await expect(withRetry(fn, strategy, 2)).rejects.toThrow('persistent failure');
  });

  it('throws immediately when strategy says not to retry', async () => {
    let callCount = 0;
    const strategy: RetryStrategy = {
      shouldRetry: () => false,
      getDelay: () => 0,
    };

    const fn = async () => {
      callCount++;
      throw new Error('no retry');
    };

    await expect(withRetry(fn, strategy, 5)).rejects.toThrow('no retry');
    expect(callCount).toBe(1);
  });
});
