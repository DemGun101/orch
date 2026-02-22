// ─── Core ────────────────────────────────────────────────────────────
export { Orchestrator } from './core/orchestrator.js';
export { WorkflowEngine, validateDAG, topologicalSort } from './core/workflow-engine.js';
export { TaskManager } from './core/task-manager.js';

// ─── SDK ─────────────────────────────────────────────────────────────
export { SDKBridge } from './sdk/bridge.js';
export { FileOwnershipManager } from './sdk/file-ownership.js';
export { createAgentDef, createPlannerAgentDef } from './sdk/agent-factory.js';
export { parseSDKStream } from './sdk/result-parser.js';

// ─── Feedback ────────────────────────────────────────────────────────
export { createFeedbackWorkflow, planToWorkflow } from './feedback/feedback-loop.js';

// ─── Resilience ──────────────────────────────────────────────────────
export { ExponentialBackoff, CircuitBreaker, CircuitOpenError, withRetry } from './resilience/retry-strategies.js';
export { RateLimiter, APIRateLimiter, ConcurrencyLimiter } from './resilience/rate-limiter.js';
export { CheckpointManager } from './resilience/checkpointing.js';
export {
  OrchestratorError,
  TaskExecutionError,
  AgentError,
  APIError,
  WorkflowError,
  ValidationError,
  TimeoutError,
} from './resilience/error-handler.js';

// ─── Monitoring ──────────────────────────────────────────────────────
export { MetricsCollector, METRICS } from './monitoring/metrics.js';

// ─── Memory ──────────────────────────────────────────────────────────
export { PersistenceLayer } from './memory/persistence.js';
export { SharedMemoryStore } from './memory/shared-memory.js';

// ─── Config ──────────────────────────────────────────────────────────
export { DEFAULT_CONFIG, validateConfig } from './config/schema.js';

// ─── MCP ─────────────────────────────────────────────────────────────
export { startMCPServer } from './mcp/server.js';

// ─── Types ───────────────────────────────────────────────────────────
export type {
  Task,
  TaskStatus,
  TaskPriority,
  TaskResult,
  TaskMetadata,
  Workflow,
  WorkflowNode,
  WorkflowEdge,
  WorkflowResult,
  AuditEntry,
  ModelTier,
  PlanNode,
  Plan,
  CoworkAgentDef,
  SDKNodeResult,
  CoworkConfig,
  NodeExecutor,
  AgentMessage,
  AgentConfig,
} from './core/types.js';
