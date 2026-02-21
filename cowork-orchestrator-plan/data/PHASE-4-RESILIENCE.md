# Phase 4 — Resilience & Polish (Error Handling, Rate Limiting, Production Hardening)

> **Copy-paste this entire prompt into Claude Code. This makes the system production-grade.**

---

```
We are finishing the "cowork-orchestrator" project. Phases 1-3 are complete. Now implement the resilience layer and polish everything for production readiness.

## 1. src/resilience/retry-strategies.ts — Retry Strategies

Implement retry logic:
- `RetryStrategy` interface: `{ shouldRetry(error, attempt): boolean, getDelay(attempt): number }`
- `ExponentialBackoff` class implements `RetryStrategy`:
  - Config: `{ baseDelay: 1000, maxDelay: 60000, factor: 2, jitter: true }`
  - Delay formula: `min(baseDelay * factor^attempt + jitter, maxDelay)`
  - Jitter: random 0-30% of calculated delay
- `CircuitBreaker` class:
  - States: CLOSED (normal), OPEN (failing, reject all), HALF_OPEN (testing recovery)
  - Config: `{ failureThreshold: 5, recoveryTimeout: 30000, successThreshold: 2 }`
  - CLOSED → OPEN: when failures >= failureThreshold within window
  - OPEN → HALF_OPEN: after recoveryTimeout
  - HALF_OPEN → CLOSED: after successThreshold consecutive successes
  - HALF_OPEN → OPEN: on any failure
  - `execute<T>(fn: () => Promise<T>): Promise<T>` — wraps a function with circuit breaker logic
  - `getState()`, `getStats()`, `reset()`
- `withRetry<T>(fn, strategy, maxAttempts): Promise<T>` — generic retry wrapper

## 2. src/resilience/rate-limiter.ts — Rate Limiting

Implement `RateLimiter` class:
- Token bucket algorithm:
  - Config: `{ maxTokens, refillRate (tokens per second), refillInterval }`
  - `acquire(tokens?: number): Promise<void>` — waits until tokens available
  - `tryAcquire(tokens?: number): boolean` — non-blocking, returns false if no tokens
  - `getAvailable(): number`
- `APIRateLimiter` extends `RateLimiter`:
  - Tracks both requests/minute AND tokens/minute (dual bucket)
  - `acquireRequest()` — consumes 1 request token
  - `acquireTokens(count: number)` — consumes from token bucket
  - `recordUsage(inputTokens, outputTokens)` — record actual usage after API call
  - Respects Anthropic rate limit headers: parse `retry-after`, `x-ratelimit-*` headers
  - Auto-adjusts based on 429 responses: reduce rate, then slowly recover
- `ConcurrencyLimiter`:
  - Config: `{ maxConcurrent: number }`
  - `acquire(): Promise<() => void>` — returns a release function
  - Queues requests when at max concurrency

## 3. src/resilience/checkpointing.ts — Workflow Checkpoints

Implement `CheckpointManager` class:
- `createCheckpoint(workflowId: string, state: WorkflowState): string` — saves full state, returns checkpoint ID
- `WorkflowState` includes:
  - All completed node outputs
  - Current node statuses
  - Shared context/memory snapshot
  - Conversation histories for active agents
  - Pending task queue state
- `getCheckpoint(checkpointId: string): WorkflowState`
- `getLatestCheckpoint(workflowId: string): WorkflowState | undefined`
- `restoreFromCheckpoint(checkpointId: string): RestorationPlan`
  - Returns a plan: which nodes to skip (already done), which to resume, which to re-run
- `listCheckpoints(workflowId): CheckpointInfo[]` — list all checkpoints with timestamps
- `pruneCheckpoints(workflowId, keepLast: number)` — delete old checkpoints
- Automatic checkpointing: integrate with WorkflowEngine to checkpoint after every node completion
- Persistence: store checkpoints in SQLite via PersistenceLayer

## 4. src/resilience/error-handler.ts — Centralized Error Handling

Implement `ErrorHandler` class:
- Custom error hierarchy:
  - `OrchestratorError` (base) — with `code`, `context`, `recoverable` fields
  - `TaskExecutionError` — task-level failures
  - `AgentError` — agent failures (crash, timeout, invalid response)
  - `ToolExecutionError` — tool failures
  - `APIError` — Anthropic API errors (rate limit, server error, auth)
  - `WorkflowError` — workflow-level failures (DAG error, checkpoint error)
  - `ValidationError` — input/output validation failures
  - `TimeoutError` — operation timeouts
- `handleError(error: OrchestratorError): Promise<ErrorRecoveryAction>`
  - Decides recovery action based on error type and context:
    - `RETRY` — retry the operation (with backoff)
    - `REASSIGN` — assign task to a different agent
    - `DECOMPOSE` — break task into smaller pieces and retry
    - `SKIP` — skip this step (if non-critical) and continue workflow
    - `ESCALATE` — flag for human intervention
    - `ABORT` — abort the entire workflow
  - Uses error severity + retry count + circuit breaker state to decide
- `withErrorHandling<T>(fn, context): Promise<T>` — wraps any async function with error handling
- Global error event emission for monitoring
- Error aggregation: detect patterns (e.g., same agent failing repeatedly → mark agent as degraded)

## 5. Update Core — Wire Resilience Into Everything

Update `OrchestrationEngine`:
- Initialize all resilience components (ErrorHandler, RateLimiter, CircuitBreaker, CheckpointManager)
- Wrap all Anthropic API calls with: RateLimiter → CircuitBreaker → RetryStrategy → ErrorHandler
- Add global error handler that catches unhandled errors
- Graceful shutdown: on SIGTERM/SIGINT:
  1. Stop accepting new tasks
  2. Wait for running tasks (with 30s timeout)
  3. Checkpoint all active workflows
  4. Close DB connections
  5. Exit cleanly

Update `ClaudeAgent`:
- Wrap `execute()` with retry + circuit breaker + rate limiting
- On transient API errors (429, 500, 529), retry with exponential backoff
- On persistent failures, circuit breaker opens → tasks get reassigned
- Track error rates in agent stats

Update `WorkflowEngine`:
- Auto-checkpoint after each node
- On failure, consult ErrorHandler for recovery action
- Implement resume from checkpoint in `execute()`: check for existing checkpoint, restore if found
- Add workflow-level timeout

Update `ToolExecutor`:
- Wrap each tool execution with error handling + timeout
- CircuitBreaker per tool (if a tool keeps failing, stop calling it)

## 6. Final Tests

Create `tests/unit/retry-strategies.test.ts`:
- Test exponential backoff delays and jitter
- Test circuit breaker state transitions (CLOSED → OPEN → HALF_OPEN → CLOSED)
- Test circuit breaker with concurrent requests

Create `tests/unit/rate-limiter.test.ts`:
- Test token bucket refill logic
- Test concurrent acquire/release
- Test dual bucket (requests + tokens)

Create `tests/unit/error-handler.test.ts`:
- Test recovery action selection for each error type
- Test error aggregation and pattern detection

Create `tests/integration/resilience.test.ts`:
- Test full flow: submit task → API error → retry → success
- Test full flow: submit task → agent failure → reassign → success
- Test full flow: workflow → crash simulation → checkpoint → resume → complete
- Test rate limiting under load (submit 100 tasks, verify rate limits respected)

After all files:
1. `npx tsc --noEmit` — must compile clean
2. `npm test` — all tests must pass
3. Fix any issues

Commit: "feat: implement resilience layer — retry, circuit breaker, rate limiting, checkpointing, error recovery"

## 7. Final Polish — One Last Pass

After the resilience layer is wired up, do one final pass:
1. Run `npx tsc --noEmit` and fix ALL type errors
2. Run `npm test` and fix ALL failing tests
3. Update `README.md` with:
   - Project description
   - Architecture diagram (ASCII art showing the layers: Core → Intelligence → Integration → Resilience)
   - Quick start guide (install, set API key, run example)
   - API overview (key classes and methods)
   - Example usage code
4. Create `examples/README.md` explaining each example
5. Run `npx eslint src/ --ext .ts --fix` to clean up code style
6. Final commit: "chore: final polish — docs, lint, all tests passing"
```
