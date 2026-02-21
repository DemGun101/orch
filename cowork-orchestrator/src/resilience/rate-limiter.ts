// ─── Token Bucket Rate Limiter ──────────────────────────────────────

export interface RateLimiterConfig {
  maxTokens: number;
  refillRate: number; // tokens per second
}

export class RateLimiter {
  private maxTokens: number;
  private currentTokens: number;
  private refillRate: number;
  private lastRefill: number;

  constructor(config: RateLimiterConfig) {
    this.maxTokens = config.maxTokens;
    this.currentTokens = config.maxTokens;
    this.refillRate = config.refillRate;
    this.lastRefill = Date.now();
  }

  async acquire(tokens: number = 1): Promise<void> {
    this.refill();

    if (this.currentTokens >= tokens) {
      this.currentTokens -= tokens;
      return;
    }

    // Calculate wait time until enough tokens are available
    const deficit = tokens - this.currentTokens;
    const waitMs = (deficit / this.refillRate) * 1000;

    await new Promise<void>((resolve) => setTimeout(resolve, Math.ceil(waitMs)));

    this.refill();
    this.currentTokens -= tokens;
  }

  tryAcquire(tokens: number = 1): boolean {
    this.refill();

    if (this.currentTokens >= tokens) {
      this.currentTokens -= tokens;
      return true;
    }

    return false;
  }

  getAvailable(): number {
    this.refill();
    return this.currentTokens;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    const tokensToAdd = elapsed * this.refillRate;

    this.currentTokens = Math.min(
      this.maxTokens,
      this.currentTokens + tokensToAdd,
    );
    this.lastRefill = now;
  }
}

// ─── API Rate Limiter (Dual Bucket) ────────────────────────────────

export interface APIRateLimiterConfig {
  requestsPerMinute: number;
  tokensPerMinute: number;
}

export class APIRateLimiter {
  private requestBucket: RateLimiter;
  private tokenBucket: RateLimiter;
  private requestsUsed = 0;
  private tokensUsed = 0;
  private pausedUntil = 0;

  constructor(config: APIRateLimiterConfig) {
    this.requestBucket = new RateLimiter({
      maxTokens: config.requestsPerMinute,
      refillRate: config.requestsPerMinute / 60,
    });
    this.tokenBucket = new RateLimiter({
      maxTokens: config.tokensPerMinute,
      refillRate: config.tokensPerMinute / 60,
    });
  }

  async acquireRequest(): Promise<void> {
    // Wait if paused due to 429
    const now = Date.now();
    if (now < this.pausedUntil) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, this.pausedUntil - now),
      );
    }

    await this.requestBucket.acquire(1);
    this.requestsUsed++;
  }

  async acquireTokens(count: number): Promise<void> {
    await this.tokenBucket.acquire(count);
  }

  recordUsage(inputTokens: number, outputTokens: number): void {
    this.tokensUsed += inputTokens + outputTokens;
  }

  handleRateLimitResponse(retryAfterMs: number): void {
    this.pausedUntil = Date.now() + retryAfterMs;
  }

  getStats(): {
    requestsAvailable: number;
    tokensAvailable: number;
    requestsUsed: number;
    tokensUsed: number;
  } {
    return {
      requestsAvailable: this.requestBucket.getAvailable(),
      tokensAvailable: this.tokenBucket.getAvailable(),
      requestsUsed: this.requestsUsed,
      tokensUsed: this.tokensUsed,
    };
  }
}

// ─── Concurrency Limiter ────────────────────────────────────────────

export interface ConcurrencyLimiterConfig {
  maxConcurrent: number;
}

export class ConcurrencyLimiter {
  private maxConcurrent: number;
  private active = 0;
  private waiting: Array<() => void> = [];

  constructor(config: ConcurrencyLimiterConfig) {
    this.maxConcurrent = config.maxConcurrent;
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return this.createRelease();
    }

    // Queue the request
    return new Promise<() => void>((resolve) => {
      this.waiting.push(() => {
        this.active++;
        resolve(this.createRelease());
      });
    });
  }

  getActive(): number {
    return this.active;
  }

  getWaiting(): number {
    return this.waiting.length;
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;

      if (this.waiting.length > 0) {
        const next = this.waiting.shift()!;
        next();
      }
    };
  }
}
