import { describe, it, expect, vi } from 'vitest';
import {
  OrchestratorError,
  TaskExecutionError,
  AgentError,
  ToolExecutionError,
  APIError,
  ValidationError,
  TimeoutError,
  ErrorHandler,
} from '../../src/resilience/error-handler.js';

describe('ErrorHandler', () => {
  // ─── APIError handling ───────────────────────────────────────────

  describe('handleError — APIError', () => {
    it('returns RETRY for APIError 429 (retryCount=0)', async () => {
      const handler = new ErrorHandler();
      const error = new APIError('rate limited', 429, { retryCount: 0 });

      const action = await handler.handleError(error);

      expect(action).toBe('RETRY');
    });

    it('returns RETRY for APIError 500 (retryCount=0)', async () => {
      const handler = new ErrorHandler();
      const error = new APIError('server error', 500, { retryCount: 0 });

      const action = await handler.handleError(error);

      expect(action).toBe('RETRY');
    });

    it('returns ABORT for APIError 401', async () => {
      const handler = new ErrorHandler();
      const error = new APIError('unauthorized', 401, { retryCount: 0 });

      const action = await handler.handleError(error);

      expect(action).toBe('ABORT');
    });

    it('returns ABORT for APIError 403', async () => {
      const handler = new ErrorHandler();
      const error = new APIError('forbidden', 403, { retryCount: 0 });

      const action = await handler.handleError(error);

      expect(action).toBe('ABORT');
    });
  });

  // ─── TaskExecutionError handling ─────────────────────────────────

  describe('handleError — TaskExecutionError', () => {
    it('returns RETRY when retryCount is below maxRetries', async () => {
      const handler = new ErrorHandler({ maxRetries: 3 });
      const error = new TaskExecutionError('task failed', { retryCount: 0 });

      const action = await handler.handleError(error);

      expect(action).toBe('RETRY');
    });

    it('returns REASSIGN when retryCount equals maxRetries', async () => {
      const handler = new ErrorHandler({ maxRetries: 3 });
      const error = new TaskExecutionError('task failed', { retryCount: 3 });

      const action = await handler.handleError(error);

      expect(action).toBe('REASSIGN');
    });
  });

  // ─── AgentError handling ─────────────────────────────────────────

  describe('handleError — AgentError', () => {
    it('returns REASSIGN when agent has 3+ recent errors', async () => {
      const handler = new ErrorHandler();
      const agentId = 'agent-flaky';

      // Record 3 errors to push the agent over the threshold
      handler.recordError(agentId, new AgentError('fail 1', { agentId }));
      handler.recordError(agentId, new AgentError('fail 2', { agentId }));
      handler.recordError(agentId, new AgentError('fail 3', { agentId }));

      const error = new AgentError('fail 4', { agentId, retryCount: 0 });
      const action = await handler.handleError(error);

      expect(action).toBe('REASSIGN');
    });
  });

  // ─── ToolExecutionError handling ─────────────────────────────────

  describe('handleError — ToolExecutionError', () => {
    it('returns SKIP when retryCount >= 1', async () => {
      const handler = new ErrorHandler();
      const error = new ToolExecutionError('tool broke', { retryCount: 1 });

      const action = await handler.handleError(error);

      expect(action).toBe('SKIP');
    });
  });

  // ─── TimeoutError handling ───────────────────────────────────────

  describe('handleError — TimeoutError', () => {
    it('returns RETRY when retryCount is below maxRetries', async () => {
      const handler = new ErrorHandler({ maxRetries: 3 });
      const error = new TimeoutError('timed out', { retryCount: 0 });

      const action = await handler.handleError(error);

      expect(action).toBe('RETRY');
    });

    it('returns DECOMPOSE when retryCount equals maxRetries', async () => {
      const handler = new ErrorHandler({ maxRetries: 3 });
      const error = new TimeoutError('timed out', { retryCount: 3 });

      const action = await handler.handleError(error);

      expect(action).toBe('DECOMPOSE');
    });
  });

  // ─── ValidationError handling ────────────────────────────────────

  describe('handleError — ValidationError', () => {
    it('returns ABORT for ValidationError', async () => {
      const handler = new ErrorHandler();
      const error = new ValidationError('invalid input', { field: 'name' });

      const action = await handler.handleError(error);

      expect(action).toBe('ABORT');
    });
  });

  // ─── Default / unknown error handling ────────────────────────────

  describe('handleError — unknown OrchestratorError', () => {
    it('returns ESCALATE for a generic OrchestratorError', async () => {
      const handler = new ErrorHandler();
      const error = new OrchestratorError('something unexpected', 'UNKNOWN', true);

      const action = await handler.handleError(error);

      expect(action).toBe('ESCALATE');
    });
  });

  // ─── getErrorPatterns ────────────────────────────────────────────

  describe('getErrorPatterns', () => {
    it('returns correct counts after recording errors', () => {
      const handler = new ErrorHandler();
      const agentId = 'agent-counting';

      handler.recordError(agentId, new TaskExecutionError('err 1'));
      handler.recordError(agentId, new TaskExecutionError('err 2'));

      const patterns = handler.getErrorPatterns(agentId);

      expect(patterns.totalErrors).toBe(2);
      expect(patterns.recentErrors).toBe(2);
      expect(patterns.isDegraded).toBe(false);
    });

    it('marks agent as degraded after escalationThreshold errors', () => {
      const handler = new ErrorHandler({ escalationThreshold: 3 });
      const agentId = 'agent-degraded';

      handler.recordError(agentId, new TaskExecutionError('err 1'));
      handler.recordError(agentId, new TaskExecutionError('err 2'));
      handler.recordError(agentId, new TaskExecutionError('err 3'));

      const patterns = handler.getErrorPatterns(agentId);

      expect(patterns.isDegraded).toBe(true);
      expect(patterns.recentErrors).toBe(3);
    });
  });

  // ─── withErrorHandling ───────────────────────────────────────────

  describe('withErrorHandling', () => {
    it('wraps thrown errors and rethrows with recoveryAction', async () => {
      const handler = new ErrorHandler();
      const failingFn = async () => {
        throw new TaskExecutionError('inner fail', { retryCount: 0 });
      };

      let caughtError: OrchestratorError | undefined;

      try {
        await handler.withErrorHandling(failingFn, { operation: 'test-op' });
      } catch (err) {
        caughtError = err as OrchestratorError;
      }

      expect(caughtError).toBeInstanceOf(OrchestratorError);
      expect(caughtError!.context.recoveryAction).toBe('RETRY');
    });
  });
});
