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
