import { query } from '@anthropic-ai/claude-agent-sdk';
import type { CoworkAgentDef, SDKNodeResult, CoworkConfig } from '../core/types.js';
import { parseSDKStream } from './result-parser.js';
import { FileOwnershipManager } from './file-ownership.js';
import { CircuitBreaker, CircuitOpenError } from '../resilience/retry-strategies.js';
import { APIRateLimiter, ConcurrencyLimiter } from '../resilience/rate-limiter.js';
import { MetricsCollector, METRICS } from '../monitoring/metrics.js';

// ─── SDK Bridge ─────────────────────────────────────────────────────
// Wraps SDK query() with circuit breaker, rate limiter, concurrency
// limiter, file ownership, and metrics.

export class SDKBridge {
  private circuitBreakers = new Map<string, CircuitBreaker>();
  private rateLimiter: APIRateLimiter;
  private concurrencyLimiter: ConcurrencyLimiter;
  private fileOwnership: FileOwnershipManager;
  private metrics: MetricsCollector;
  private config: CoworkConfig;

  constructor(
    config: CoworkConfig,
    fileOwnership: FileOwnershipManager,
    metrics: MetricsCollector,
  ) {
    this.config = config;
    this.fileOwnership = fileOwnership;
    this.metrics = metrics;

    this.rateLimiter = new APIRateLimiter({
      requestsPerMinute: config.rateLimits.requestsPerMinute,
      tokensPerMinute: config.rateLimits.tokensPerMinute,
    });

    this.concurrencyLimiter = new ConcurrencyLimiter({
      maxConcurrent: config.maxConcurrency,
    });
  }

  /**
   * Execute a single agent via SDK query().
   * Applies circuit breaker, rate limiting, concurrency control,
   * and file ownership enforcement.
   */
  async execute(agentDef: CoworkAgentDef): Promise<SDKNodeResult> {
    const breaker = this.getCircuitBreaker(agentDef.id);
    const stopTimer = this.metrics.startTimer(METRICS.API_LATENCY, { agent: agentDef.id });

    // Acquire concurrency slot
    const release = await this.concurrencyLimiter.acquire();

    try {
      // Rate limit
      await this.rateLimiter.acquireRequest();

      // Execute through circuit breaker
      const result = await breaker.execute(async () => {
        this.metrics.increment(METRICS.API_REQUESTS, { agent: agentDef.id });

        // Build canUseTool callback for file ownership
        const ownershipCheck = this.fileOwnership.createCanUseToolCallback(agentDef.id);

        const canUseTool = async (
          toolName: string,
          input: Record<string, unknown>,
        ) => {
          const check = ownershipCheck(toolName, input);
          if (check.behavior === 'deny') {
            return {
              behavior: 'deny' as const,
              message: check.message ?? 'Permission denied',
            };
          }
          return { behavior: 'allow' as const };
        };

        // Build SDK query options
        const options: Record<string, unknown> = {
          systemPrompt: agentDef.systemPrompt,
          model: agentDef.model,
          permissionMode: 'acceptEdits',
          maxTurns: agentDef.maxTurns ?? 30,
          canUseTool,
        };

        if (agentDef.tools) {
          options.tools = agentDef.tools;
        }

        if (this.config.cwd) {
          options.cwd = this.config.cwd;
        }

        // Unset CLAUDECODE env var to allow nested SDK calls
        const prevClaudeCode = process.env.CLAUDECODE;
        delete process.env.CLAUDECODE;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let stream: AsyncIterable<any>;
        try {
          stream = query({
            prompt: agentDef.prompt,
            options: options as Parameters<typeof query>[0]['options'],
          });
        } catch (spawnError) {
          // Restore env var on spawn failure
          if (prevClaudeCode !== undefined) process.env.CLAUDECODE = prevClaudeCode;
          throw spawnError;
        }

        try {
          return await parseSDKStream(agentDef.id, stream);
        } finally {
          if (prevClaudeCode !== undefined) process.env.CLAUDECODE = prevClaudeCode;
        }
      });

      // Record token usage
      if (result.tokenUsage) {
        this.metrics.record(METRICS.API_TOKENS_IN, result.tokenUsage.input, { agent: agentDef.id });
        this.metrics.record(METRICS.API_TOKENS_OUT, result.tokenUsage.output, { agent: agentDef.id });
        this.rateLimiter.recordUsage(result.tokenUsage.input, result.tokenUsage.output);
      }

      if (result.success) {
        this.metrics.increment(METRICS.TASKS_COMPLETED, { agent: agentDef.id });
      } else {
        this.metrics.increment(METRICS.TASKS_FAILED, { agent: agentDef.id });
      }

      return result;
    } catch (error) {
      this.metrics.increment(METRICS.API_ERRORS, { agent: agentDef.id });

      if (error instanceof CircuitOpenError) {
        return {
          nodeId: agentDef.id,
          success: false,
          output: '',
          error: `Circuit breaker open for agent "${agentDef.id}". Too many recent failures.`,
          duration: 0,
          filesModified: [],
        };
      }

      const errMsg = error instanceof Error ? error.message : String(error);
      const errStack = error instanceof Error ? error.stack : undefined;
      process.stderr.write(`[SDKBridge] Agent "${agentDef.id}" error: ${errMsg}\n`);
      if (errStack) process.stderr.write(`[SDKBridge] Stack: ${errStack}\n`);

      return {
        nodeId: agentDef.id,
        success: false,
        output: '',
        error: errMsg,
        duration: 0,
        filesModified: [],
      };
    } finally {
      stopTimer();
      release();
    }
  }

  /** Get or create a circuit breaker for an agent */
  private getCircuitBreaker(agentId: string): CircuitBreaker {
    let breaker = this.circuitBreakers.get(agentId);
    if (!breaker) {
      breaker = new CircuitBreaker({
        failureThreshold: 3,
        recoveryTimeout: 60_000,
        successThreshold: 1,
        windowMs: 120_000,
      });
      this.circuitBreakers.set(agentId, breaker);
    }
    return breaker;
  }

  /** Get rate limiter stats */
  getRateLimiterStats() {
    return this.rateLimiter.getStats();
  }

  /** Get concurrency info */
  getConcurrencyInfo() {
    return {
      active: this.concurrencyLimiter.getActive(),
      waiting: this.concurrencyLimiter.getWaiting(),
      max: this.config.maxConcurrency,
    };
  }

  /** Get circuit breaker stats for all agents */
  getCircuitBreakerStats(): Record<string, { state: string; failureCount: number }> {
    const stats: Record<string, { state: string; failureCount: number }> = {};
    for (const [id, breaker] of this.circuitBreakers) {
      const s = breaker.getStats();
      stats[id] = { state: s.state, failureCount: s.failureCount };
    }
    return stats;
  }
}
