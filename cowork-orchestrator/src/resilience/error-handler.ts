import { EventEmitter } from 'eventemitter3';

// ─── Error Hierarchy ────────────────────────────────────────────────

export class OrchestratorError extends Error {
  readonly code: string;
  readonly context: Record<string, unknown>;
  readonly recoverable: boolean;

  constructor(
    message: string,
    code: string,
    recoverable: boolean,
    context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'OrchestratorError';
    this.code = code;
    this.recoverable = recoverable;
    this.context = context;
  }
}

export class TaskExecutionError extends OrchestratorError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, 'TASK_EXECUTION', true, context);
    this.name = 'TaskExecutionError';
  }
}

export class AgentError extends OrchestratorError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, 'AGENT_ERROR', true, context);
    this.name = 'AgentError';
  }
}

export class ToolExecutionError extends OrchestratorError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, 'TOOL_EXECUTION', true, context);
    this.name = 'ToolExecutionError';
  }
}

export class APIError extends OrchestratorError {
  readonly statusCode: number;

  constructor(message: string, statusCode: number, context: Record<string, unknown> = {}) {
    const recoverable = [429, 500, 503].includes(statusCode);
    super(message, 'API_ERROR', recoverable, context);
    this.name = 'APIError';
    this.statusCode = statusCode;
  }
}

export class WorkflowError extends OrchestratorError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, 'WORKFLOW_ERROR', false, context);
    this.name = 'WorkflowError';
  }
}

export class ValidationError extends OrchestratorError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, 'VALIDATION', false, context);
    this.name = 'ValidationError';
  }
}

export class TimeoutError extends OrchestratorError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, 'TIMEOUT', true, context);
    this.name = 'TimeoutError';
  }
}

// ─── Recovery Action ────────────────────────────────────────────────

export type ErrorRecoveryAction =
  | 'RETRY'
  | 'REASSIGN'
  | 'DECOMPOSE'
  | 'SKIP'
  | 'ESCALATE'
  | 'ABORT';

// ─── Error Handler Configuration ────────────────────────────────────

export interface ErrorHandlerConfig {
  maxRetries: number;
  escalationThreshold: number;
}

// ─── Error Events ───────────────────────────────────────────────────

interface ErrorEvents {
  'error:occurred': (error: OrchestratorError) => void;
  'error:recovered': (error: OrchestratorError, action: ErrorRecoveryAction) => void;
  'error:escalated': (error: OrchestratorError) => void;
}

// ─── Agent Error Record ─────────────────────────────────────────────

interface AgentErrorRecord {
  errors: Array<{ error: OrchestratorError; timestamp: number }>;
}

// ─── Error Handler ──────────────────────────────────────────────────

export class ErrorHandler {
  private config: ErrorHandlerConfig;
  private agentErrors = new Map<string, AgentErrorRecord>();
  private emitter = new EventEmitter<ErrorEvents>();

  constructor(config?: Partial<ErrorHandlerConfig>) {
    this.config = {
      maxRetries: config?.maxRetries ?? 3,
      escalationThreshold: config?.escalationThreshold ?? 5,
    };
  }

  // ── Event helpers ─────────────────────────────────────────────────

  onErrorOccurred(handler: (error: OrchestratorError) => void): () => void {
    this.emitter.on('error:occurred', handler);
    return () => this.emitter.off('error:occurred', handler);
  }

  onErrorRecovered(handler: (error: OrchestratorError, action: ErrorRecoveryAction) => void): () => void {
    this.emitter.on('error:recovered', handler);
    return () => this.emitter.off('error:recovered', handler);
  }

  onErrorEscalated(handler: (error: OrchestratorError) => void): () => void {
    this.emitter.on('error:escalated', handler);
    return () => this.emitter.off('error:escalated', handler);
  }

  // ── Core error handling ───────────────────────────────────────────

  async handleError(error: OrchestratorError): Promise<ErrorRecoveryAction> {
    this.emitter.emit('error:occurred', error);

    const retryCount = (error.context.retryCount as number) ?? 0;
    let action: ErrorRecoveryAction;

    if (error instanceof APIError) {
      if ([401, 403].includes(error.statusCode)) {
        action = 'ABORT';
      } else if (
        [429, 500, 503].includes(error.statusCode) &&
        retryCount < this.config.maxRetries
      ) {
        action = 'RETRY';
      } else {
        action = 'ESCALATE';
      }
    } else if (error instanceof TaskExecutionError) {
      if (retryCount < this.config.maxRetries) {
        action = 'RETRY';
      } else {
        action = 'REASSIGN';
      }
    } else if (error instanceof AgentError) {
      const agentId = error.context.agentId as string | undefined;
      if (agentId) {
        const patterns = this.getErrorPatterns(agentId);
        if (patterns.recentErrors >= 3) {
          action = 'REASSIGN';
        } else if (retryCount < this.config.maxRetries) {
          action = 'RETRY';
        } else {
          action = 'REASSIGN';
        }
      } else {
        action = retryCount < this.config.maxRetries ? 'RETRY' : 'ESCALATE';
      }
    } else if (error instanceof ToolExecutionError) {
      if (retryCount < 1) {
        action = 'RETRY';
      } else {
        action = 'SKIP';
      }
    } else if (error instanceof TimeoutError) {
      if (retryCount < this.config.maxRetries) {
        action = 'RETRY';
      } else {
        action = 'DECOMPOSE';
      }
    } else if (error instanceof ValidationError) {
      action = 'ABORT';
    } else {
      action = 'ESCALATE';
    }

    if (action === 'ESCALATE') {
      this.emitter.emit('error:escalated', error);
    } else {
      this.emitter.emit('error:recovered', error, action);
    }

    return action;
  }

  async withErrorHandling<T>(
    fn: () => Promise<T>,
    context: { taskId?: string; agentId?: string; operation: string },
  ): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      let orchestratorError: OrchestratorError;

      if (error instanceof OrchestratorError) {
        orchestratorError = error;
      } else {
        const err = error instanceof Error ? error : new Error(String(error));
        const status = (err as Error & { status?: number }).status;

        if (status !== undefined) {
          orchestratorError = new APIError(err.message, status, context);
        } else if (err.message.includes('timed out') || err.message.includes('timeout')) {
          orchestratorError = new TimeoutError(err.message, context);
        } else {
          orchestratorError = new TaskExecutionError(err.message, context);
        }
      }

      if (context.agentId) {
        this.recordError(context.agentId, orchestratorError);
      }

      const action = await this.handleError(orchestratorError);

      // Attach the recovery action to the error for upstream handling
      orchestratorError.context.recoveryAction = action;
      throw orchestratorError;
    }
  }

  recordError(agentId: string, error: OrchestratorError): void {
    if (!this.agentErrors.has(agentId)) {
      this.agentErrors.set(agentId, { errors: [] });
    }

    const record = this.agentErrors.get(agentId)!;
    record.errors.push({ error, timestamp: Date.now() });

    // Keep only recent errors (last 5 minutes)
    const cutoff = Date.now() - 5 * 60 * 1000;
    record.errors = record.errors.filter((e) => e.timestamp > cutoff);
  }

  getErrorPatterns(agentId: string): {
    totalErrors: number;
    recentErrors: number;
    isDegraded: boolean;
  } {
    const record = this.agentErrors.get(agentId);
    if (!record) {
      return { totalErrors: 0, recentErrors: 0, isDegraded: false };
    }

    // Prune old errors
    const cutoff = Date.now() - 5 * 60 * 1000;
    record.errors = record.errors.filter((e) => e.timestamp > cutoff);

    const recentErrors = record.errors.length;
    return {
      totalErrors: recentErrors,
      recentErrors,
      isDegraded: recentErrors >= this.config.escalationThreshold,
    };
  }
}
