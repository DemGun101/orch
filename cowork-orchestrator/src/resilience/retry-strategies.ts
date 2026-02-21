// ─── Retry Strategy Interface ───────────────────────────────────────

export interface RetryStrategy {
  shouldRetry(error: Error, attempt: number): boolean;
  getDelay(attempt: number): number;
}

// ─── Exponential Backoff Configuration ──────────────────────────────

export interface ExponentialBackoffConfig {
  baseDelay: number;
  maxDelay: number;
  factor: number;
  jitter: boolean;
  maxAttempts: number;
  retryableErrors?: string[];
}

const DEFAULT_BACKOFF_CONFIG: ExponentialBackoffConfig = {
  baseDelay: 1000,
  maxDelay: 60000,
  factor: 2,
  jitter: true,
  maxAttempts: 3,
};

// ─── Exponential Backoff ────────────────────────────────────────────

export class ExponentialBackoff implements RetryStrategy {
  private config: ExponentialBackoffConfig;

  constructor(config?: Partial<ExponentialBackoffConfig>) {
    this.config = { ...DEFAULT_BACKOFF_CONFIG, ...config };
  }

  shouldRetry(error: Error, attempt: number): boolean {
    if (attempt >= this.config.maxAttempts) return false;

    // Check HTTP status codes on the error object
    const status = (error as Error & { status?: number }).status;
    if (status !== undefined && [429, 500, 503].includes(status)) {
      return true;
    }

    // Check retryable error patterns
    if (this.config.retryableErrors && this.config.retryableErrors.length > 0) {
      const errorString = `${error.name} ${error.message}`.toLowerCase();
      return this.config.retryableErrors.some(
        (pattern) => errorString.includes(pattern.toLowerCase()),
      );
    }

    // Default: retry on any error if no retryableErrors filter is set
    return true;
  }

  getDelay(attempt: number): number {
    const delay = Math.min(
      this.config.baseDelay * Math.pow(this.config.factor, attempt),
      this.config.maxDelay,
    );

    if (this.config.jitter) {
      const jitterAmount = delay * 0.3 * Math.random();
      return Math.floor(delay + jitterAmount);
    }

    return delay;
  }
}

// ─── Circuit Breaker ────────────────────────────────────────────────

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitOpenError extends Error {
  constructor(message = 'Circuit breaker is OPEN') {
    super(message);
    this.name = 'CircuitOpenError';
  }
}

export interface CircuitBreakerConfig {
  failureThreshold: number;
  recoveryTimeout: number;
  successThreshold: number;
  windowMs: number;
}

export interface CircuitBreakerStats {
  state: CircuitState;
  failureCount: number;
  successCount: number;
  lastFailure: Date | null;
  lastStateChange: Date;
}

const DEFAULT_CIRCUIT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  recoveryTimeout: 30000,
  successThreshold: 2,
  windowMs: 60000,
};

export class CircuitBreaker {
  private config: CircuitBreakerConfig;
  private state: CircuitState = 'CLOSED';
  private failureTimestamps: number[] = [];
  private halfOpenSuccesses = 0;
  private lastFailure: Date | null = null;
  private lastStateChange: Date = new Date();
  private openedAt = 0;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = { ...DEFAULT_CIRCUIT_CONFIG, ...config };
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Check state transitions before executing
    if (this.state === 'OPEN') {
      // Check if recovery timeout has passed → transition to HALF_OPEN
      if (Date.now() - this.openedAt >= this.config.recoveryTimeout) {
        this.transitionTo('HALF_OPEN');
      } else {
        throw new CircuitOpenError();
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  getState(): CircuitState {
    // Check for automatic OPEN → HALF_OPEN transition
    if (
      this.state === 'OPEN' &&
      Date.now() - this.openedAt >= this.config.recoveryTimeout
    ) {
      this.transitionTo('HALF_OPEN');
    }
    return this.state;
  }

  getStats(): CircuitBreakerStats {
    return {
      state: this.getState(),
      failureCount: this.failureTimestamps.length,
      successCount: this.halfOpenSuccesses,
      lastFailure: this.lastFailure,
      lastStateChange: this.lastStateChange,
    };
  }

  reset(): void {
    this.state = 'CLOSED';
    this.failureTimestamps = [];
    this.halfOpenSuccesses = 0;
    this.lastFailure = null;
    this.lastStateChange = new Date();
    this.openedAt = 0;
  }

  private onSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= this.config.successThreshold) {
        this.transitionTo('CLOSED');
        this.failureTimestamps = [];
        this.halfOpenSuccesses = 0;
      }
    } else if (this.state === 'CLOSED') {
      // Clear old failures outside the window
      this.pruneFailures();
    }
  }

  private onFailure(): void {
    const now = Date.now();
    this.lastFailure = new Date();

    if (this.state === 'HALF_OPEN') {
      // Any failure in HALF_OPEN → back to OPEN
      this.transitionTo('OPEN');
      this.openedAt = now;
      this.halfOpenSuccesses = 0;
    } else if (this.state === 'CLOSED') {
      this.failureTimestamps.push(now);
      this.pruneFailures();

      if (this.failureTimestamps.length >= this.config.failureThreshold) {
        this.transitionTo('OPEN');
        this.openedAt = now;
      }
    }
  }

  private pruneFailures(): void {
    const cutoff = Date.now() - this.config.windowMs;
    this.failureTimestamps = this.failureTimestamps.filter((t) => t > cutoff);
  }

  private transitionTo(newState: CircuitState): void {
    this.state = newState;
    this.lastStateChange = new Date();
  }
}

// ─── withRetry Utility ──────────────────────────────────────────────

export async function withRetry<T>(
  fn: () => Promise<T>,
  strategy: RetryStrategy,
  maxAttempts: number,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < maxAttempts - 1 && strategy.shouldRetry(lastError, attempt)) {
        const delay = strategy.getDelay(attempt);
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      } else {
        throw lastError;
      }
    }
  }

  throw lastError ?? new Error('Max retry attempts exceeded');
}
